/**
 * Created by AimmeeXue on 2018/3/3.
 */

/*
MdpPerceptualContentAwareRule is to use MDP model and DPAgent to get a switchRequest.
It can be divided into two parts -- offline trainer and online runner.
* **/

import DashEnvModel from '../../../dash/models/DashEnvModel';
import RL from '../../../../mytest/app/lib/reinforcementLearning/rl';
import ManifestUpdater from '../../ManifestUpdater';

import EventBus from '../../../core/EventBus';
import Events from '../../../core/events/Events';
import FactoryMaker from '../../../core/FactoryMaker';
import SwitchRequest from '../SwitchRequest.js';
import {HTTPRequest} from '../../vo/metrics/HTTPRequest';
import AbrController from '../../controllers/AbrController';
import BufferController from '../../controllers/BufferController';
import Debug from '../../../core/Debug';
import DashAdapter from '../../../dash/DashAdapter';
import MediaPlayerModel from '../../models/MediaPlayerModel';
import BitrateInfo from '../../vo/BitrateInfo';


const MAX_MEASUREMENTS_TO_KEEP = 20;
const CACHE_LOAD_THRESHOLD_VIDEO = 50;
const CACHE_LOAD_THRESHOLD_AUDIO = 5;
const CACHE_LOAD_THRESHOLD_LATENCY = 50;
const INFINITYBANDWIDTH=Number.NEGATIVE_INFINITY;
const AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_LIVE = 3;
const AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD = 4;
const AVERAGE_LATENCY_SAMPLES = AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD;
const THROUGHPUT_DECREASE_SCALE = 1.3;
const THROUGHPUT_INCREASE_SCALE = 1.3;
const QUALITY_DEFAULT=0;
const INSUFFICIENT_BUFFER=2;
const MIN_BUFFER=4;

const MAX_ROUND = 1000;
const MAX_ERROR = 0.01;





function MdpPerceptualContentAwareRule(config) {

    const context = this.context;
    const dashMetrics = config.dashMetrics;
    const metricsModel = config.metricsModel;
    const streamProcessor = config.streamProcessor;

    const log = Debug(context).getInstance().log;
    const eventBus = EventBus(context).getInstance();



    let agent,
        mdpSwitch,
        dashEnvModel,
        throughputArray,
        latencyArray,
        estimatedBandwidthArray,
        abrController,
        bufferController,
        mediaPlayerModel,
        manifestUpdater,
        R_TARGET,
        requestQualityHistory,
        lastIndex,
        metrics;

    let
        bufferStateDict,
        adapter,
        fragmentDuration;

    function setup() {
        mdpSwitch = false;
        throughputArray = [];
        latencyArray = [];
        estimatedBandwidthArray=[];
        lastIndex = 0;
        dashEnvModel = DashEnvModel(context).getInstance();
        mediaPlayerModel = MediaPlayerModel(context).getInstance();
        manifestUpdater = ManifestUpdater(context).getInstance();

        abrController = streamProcessor.getABRController();
        bufferController = streamProcessor.getBufferController();

        metrics = metricsModel.getReadOnlyMetricsFor('video');
        const bufferState = (metrics.BufferState.length > 0) ? metrics.BufferState[metrics.BufferState.length - 1] : null;
        R_TARGET = bufferState.target;



        eventBus.on(Events.VIDEO_SEND_REQUEST, onVideoSendRequest, this);
        eventBus.on(Events.MDP_TRAIN, onMdpTrain, this);





        //version:3;
        bufferStateDict={};
        requestQualityHistory=[];

        adapter = DashAdapter(context).getInstance();

    }


    /*
     Offline Training
     * **/
    function onMdpTrain(e){
        var initialBuffer = 0;
        if(e.mpdIndex) initialBuffer = bufferController.getBufferLevel();
        mdpSwitch = true;
        dashEnvModel.initialize({
            streamProcessor: streamProcessor,
            manifest: manifestUpdater.getManifest(),
            bandwidth:estimatedBandwidthArray[estimatedBandwidthArray.length-1],
            buffer:initialBuffer,
            R_MAX:abrController.getRichBuffer(),
            R_MIN:MIN_BUFFER,
            R_TARGET:R_TARGET,
            R_STABLE:mediaPlayerModel.getStableBufferTime()
        });
        agent = new RL.DPAgent(dashEnvModel,{'gamma':0.9});

        var lastPolicy = [];
        var roundCnt = 0;
        var MSEError = Number.POSITIVE_INFINITY;
        while(MSEError > MAX_ERROR || roundCnt <= MAX_ROUND){
            lastPolicy = agent.P.concat();
            agent.learn();
            roundCnt ++;
            MSEError = getMSEFromArray(lastPolicy,agent.P);
        }
        log("The mdp training is finished!" + roundCnt + "round:Minimum square error(MSE) is" + MAX_ERROR + ".");
    }

    function updateBandwidthArray(mediaType,lastRequest,streamProcessor,isDynamic,abrController){
        let downloadTimeInMilliseconds;
        let latencyTimeInMilliseconds;
        if (lastRequest.trace && lastRequest.trace.length) {

            latencyTimeInMilliseconds = (lastRequest.tresponse.getTime() - lastRequest.trequest.getTime()) || 1;
            downloadTimeInMilliseconds = (lastRequest._tfinish.getTime() - lastRequest.tresponse.getTime()) || 1; //Make sure never 0 we divide by this value. Avoid infinity!

            const bytes = lastRequest.trace.reduce((a, b) => a + b.b[0], 0);

            const lastRequestThroughput = Math.round((bytes * 8) / (downloadTimeInMilliseconds / 1000));

            let throughput;
            let latency;
            //Prevent cached fragment loads from skewing the average throughput value - allow first even if cached to set allowance for ABR rules..
            if (isCachedResponse(latencyTimeInMilliseconds, downloadTimeInMilliseconds, mediaType)) {
                if (!throughputArray[mediaType] || !latencyArray[mediaType]) {
                    throughput = lastRequestThroughput / 1000;
                    latency = latencyTimeInMilliseconds;
                } else {
                    throughput = getAverageThroughput(mediaType, isDynamic);
                    latency = getAverageLatency(mediaType);
                }
            } else {
                storeLastRequestThroughputByType(mediaType, lastRequestThroughput);
                throughput = getAverageThroughput(mediaType, isDynamic);
                storeLatency(mediaType, latencyTimeInMilliseconds);
                latency = getAverageLatency(mediaType, isDynamic);
            }

            abrController.setAverageThroughput(mediaType, throughput);

            if (latency && streamProcessor.getCurrentRepresentationInfo() && streamProcessor.getCurrentRepresentationInfo().fragmentDuration) {
                latency = latency / 1000;
                fragmentDuration = streamProcessor.getCurrentRepresentationInfo().fragmentDuration;
                if (latency > fragmentDuration) {
                    throughput=INFINITYBANDWIDTH;
                    estimatedBandwidthArray.push(throughput);
                } else {
                    let deadTimeRatio = latency / fragmentDuration;
                    throughput = throughput * (1 - deadTimeRatio);
                    estimatedBandwidthArray.push(throughput);
                }
            }
        }
    }

    function onVideoSendRequest(e) {
        if (e.error) return;
        log("add by menglan, index:" + e.index + " quality:" + e.quality);
        requestQualityHistory.push(e.quality);
    }

    /*
     Online running
     * **/
    function getMaxIndex(rulesContext) {
        let estimatedBandwidth;

        const mediaInfo = rulesContext.getMediaInfo();
        const mediaType = mediaInfo.type;
        const isDynamic = streamProcessor.isDynamic();
        const lastRequest = dashMetrics.getCurrentHttpRequest(metrics);
        const bufferStateVO = (metrics.BufferState.length > 0) ? metrics.BufferState[metrics.BufferState.length - 1] : null;
        const switchRequest = SwitchRequest(context).create();

        if (!metrics || !lastRequest || lastRequest.type !== HTTPRequest.MEDIA_SEGMENT_TYPE || !bufferStateVO) {
            return switchRequest;
        }

        if (mediaType == 'video') {
            var qualityNum = dashEnvModel.getMaxNumActions();
            var curSegmentIndex = streamProcessor.getIndexHandler().getCurrentIndex();
            var S_last = getStartStateIndexForSegment(curSegmentIndex - 1, qualityNum);
            var S_cur = getStartStateIndexForSegment(curSegmentIndex, qualityNum);
            var startIndex = S_cur + (lastIndex - S_last) * qualityNum;


            updateBandwidthArray(mediaType,lastRequest,streamProcessor,isDynamic,abrController);
            if(!mdpSwitch){
                switchRequest.value = 0;
                switchRequest.reason = 'Default quality from the beginning stage!';
            }else{
                var maxQuality = 0;
                var maxPoss = 0;
                for (var i = 0; i < qualityNum; i++) {
                    if (agent.P[startIndex + i] > maxPoss) {
                        maxPoss = agent.P[startIndex+i];
                        maxQuality = i;
                    }
                }
                switchRequest.value = maxQuality;
                switchRequest.reason = 'get max quality from mdp trained result';
            }
            lastIndex = startIndex + switchRequest.value;

        }else if(mediaType=='audio'){
            //choose the audio quality
            switchRequest.value = getQualityForAudio(mediaInfo, estimatedBandwidth);
            switchRequest.reason = 'Only throughput rule for audio'+'estimatedBandwidth:'+estimatedBandwidth;
        }

        //start to load:if the buffer is not empty, use this way to load for you can set the time delay
        if (abrController.getAbandonmentStateFor(mediaType) !== AbrController.ABANDON_LOAD) {
            if (bufferStateVO.state === BufferController.BUFFER_LOADED || isDynamic) {
                streamProcessor.getScheduleController().setTimeToLoadDelay(0);
                log( 'type: ', mediaType,'MdpPerceptualContentAwareRule requesting switch to index: ', switchRequest.value,"switch reason:", switchRequest.reason);
            }

        }

        return switchRequest;
    }



    /*auxiliary functions
     *
     *
     * **/
    function getMSEFromArray(lastPolicy,currentPolicy){
        var MSE = Number.POSITIVE_INFINITY;
        if(lastPolicy.length === currentPolicy.length){
            MSE = 0;
            var length = lastPolicy.length;
            for(var i = 0; i < length ; i++ ){
                MSE += Math.pow(lastPolicy[i]-currentPolicy[i],2);
            }
            MSE = MSE / length;
        }
        return MSE;
    }

    function getStateIndex() {

    }

    function isCachedResponse(latency, downloadTime, mediaType) {
        let ret = false;

        if (latency < CACHE_LOAD_THRESHOLD_LATENCY) {
            ret = true;
        }

        if (!ret) {
            switch (mediaType) {
                case 'video':
                    ret = downloadTime < CACHE_LOAD_THRESHOLD_VIDEO;
                    break;
                case 'audio':
                    ret = downloadTime < CACHE_LOAD_THRESHOLD_AUDIO;
                    break;
                default:
                    break;
            }
        }

        return ret;
    }

    function getSample(type, isDynamic) {
        let size = Math.min(throughputArray[type].length, isDynamic ? AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_LIVE : AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD);
        const sampleArray = throughputArray[type].slice(size * -1, throughputArray[type].length);
        if (sampleArray.length > 1) {
            sampleArray.reduce((a, b) => {
                if (a * THROUGHPUT_INCREASE_SCALE <= b || a >= b * THROUGHPUT_DECREASE_SCALE) {
                    size++;
                }
                return b;
            });
        }
        size = Math.min(throughputArray[type].length, size);
        return throughputArray[type].slice(size * -1, throughputArray[type].length);
    }

    function getAverageThroughput(type, isDynamic) {
        const sample = getSample(type, isDynamic);
        let averageThroughput = 0;
        if (sample.length > 0) {
            const totalSampledValue = sample.reduce((a, b) => a + b, 0);
            averageThroughput = totalSampledValue / sample.length;
        }
        if (throughputArray[type].length >= MAX_MEASUREMENTS_TO_KEEP) {
            throughputArray[type].shift();
        }
        return (averageThroughput / 1000 ) * mediaPlayerModel.getBandwidthSafetyFactor();
    }

    function getAverageLatency(mediaType) {
        let average;
        if (latencyArray[mediaType] && latencyArray[mediaType].length > 0) {
            average = latencyArray[mediaType].reduce((a, b) => { return a + b; }) / latencyArray[mediaType].length;
        }

        return average;
    }

    function storeLastRequestThroughputByType(type, throughput) {
        throughputArray[type] = throughputArray[type] || [];
        throughputArray[type].push(throughput);
    }

    function storeLatency(mediaType, latency) {
        if (!latencyArray[mediaType]) {
            latencyArray[mediaType] = [];
        }
        latencyArray[mediaType].push(latency);

        if (latencyArray[mediaType].length > AVERAGE_LATENCY_SAMPLES) {
            return latencyArray[mediaType].shift();
        }

        return undefined;
    }

    function getStartStateIndexForSegment(segmentIndex, qualityNum){
        return (Math.pow(qualityNum,segmentIndex)-1)/(qualityNum-1);
    }















    function setBufferInfo(type, state) {
        bufferStateDict[type] = bufferStateDict[type] || {};
        bufferStateDict[type].state = state;
        if (state === BufferController.BUFFER_LOADED && !bufferStateDict[type].firstBufferLoadedEvent) {
            bufferStateDict[type].firstBufferLoadedEvent = true;
        }
    }

    function getBitrateList(mediaInfo) {
        if (!mediaInfo || !mediaInfo.bitrateList) return null;

        var bitrateList = mediaInfo.bitrateList;
        var type = mediaInfo.type;

        var infoList = [];
        var bitrateInfo;

        for (var i = 0, ln = bitrateList.length; i < ln; i++) {
            bitrateInfo = new BitrateInfo();
            bitrateInfo.mediaType = type;
            bitrateInfo.qualityIndex = i;
            bitrateInfo.bitrate = bitrateList[i].bandwidth;
            bitrateInfo.width = bitrateList[i].width;
            bitrateInfo.height = bitrateList[i].height;
            infoList.push(bitrateInfo);
        }

        return infoList;
    }

    function getQualityFromIndex(mediaInfo,index){
        const bitrateList=getBitrateList(mediaInfo);
        if(!bitrateList||bitrateList.length===0)
            return 1000000;
        return bitrateList[index].bitrate;
    }

    function getEstimatedBufferLevel(buffer,quality,estimatedBandwidth){
        return buffer - (quality* fragmentDuration / (estimatedBandwidth*1000)) + fragmentDuration;
    }

    function getQualityForVideo(mediaInfo,estimatedBandwidth,buffer){
        var bitrate=estimatedBandwidth*buffer/fragmentDuration;
        const bitrateList = getBitrateList(mediaInfo);
        if (!bitrateList || bitrateList.length === 0) return QUALITY_DEFAULT;
        for(let i=bitrateList.length-1;i>=0;i--){
            const bitrateInfo=bitrateList[i];
            if(bitrate*1000>=bitrateInfo.bitrate)return i;
        }
        return 0;
    }

    //search for a quality to meet with the minimum buffer requirement
    function getQualityForMinimumBuffer(mediaInfo,value,estimatedBandwidth,currentBufferLevel){
        let quality,estimatedBufferLevel;
        for(let i=value;i>=0;i--){
            quality=getQualityFromIndex(mediaInfo,i);
            estimatedBufferLevel=getEstimatedBufferLevel(currentBufferLevel,quality,estimatedBandwidth);
            if(estimatedBufferLevel>=MIN_BUFFER)return i;
        }
        return 0;
    }



    function getQualityForAudio(mediaInfo,estimatedBandwidth){
        var bitrate=estimatedBandwidth;
        const bitrateList = getBitrateList(mediaInfo);
        if (!bitrateList || bitrateList.length === 0) {
            return QUALITY_DEFAULT;
        }

        for (let i = bitrateList.length - 1; i >= 0; i--) {
            const bitrateInfo = bitrateList[i];
            if (bitrate * 1000 >= bitrateInfo.bitrate) {
                return i;
            }
        }
        return 0;
    }
    //to get the next saliency which is different from the current saliency
    function getNextSaliency(currentSegmentIndex) {
        let saliencyClass=adapter.getSaliencyClass();
        if(saliencyClass && saliencyClass.length>0){
            for(let i=currentSegmentIndex;i<saliencyClass.length;i++){
                if (saliencyClass[i]!=saliencyClass[currentSegmentIndex]){
                    return saliencyClass[i];
                }
            }
        }
    }


    function getInitialQualityForSailency(foreSaliency,backSaliency,value,topQualityIndex){
        let initialValue;
        if(backSaliency>=foreSaliency)initialValue=Math.min(value+backSaliency-foreSaliency,topQualityIndex);
        else initialValue=Math.max(value-(foreSaliency-backSaliency),0);
        return initialValue;

    }

    function adjustQualityForCurrentBuffer(mediaInfo,initialValue,estimatedBandwidth,currentBufferLevel){
        let bufferAvailable;
        let currentValue=initialValue;
        if(initialValue) {
            let initialQuality = getQualityFromIndex(mediaInfo, initialValue);
            if (estimatedBandwidth && currentBufferLevel) {
                bufferAvailable = initialQuality * fragmentDuration / (estimatedBandwidth * 1000 * currentBufferLevel);
                log("Test by huaying:" + "bufferAvailable factor in roundB:" + bufferAvailable);
                if (bufferAvailable > 1) {
                    if (currentValue) {
                        bufferAvailable = 1;
                        currentValue = getQualityForVideo(mediaInfo, estimatedBandwidth, bufferAvailable * currentBufferLevel);
                    }

                }
            }
        }
        return currentValue;
    }

    function adjustQualityForMinimumBuffer(mediaInfo,value,estimatedBandwidth,currentBufferLevel){
        let currentValue=value;
        let quality=getQualityFromIndex(mediaInfo,value);
        let estimatedBufferLevel = getEstimatedBufferLevel(currentBufferLevel,quality,estimatedBandwidth);
        log("Test by huaying:" + "estimatedBufferLevel in roundC:" + estimatedBufferLevel);
        if(estimatedBufferLevel<MIN_BUFFER)
        {
            if(currentValue){
                currentValue=getQualityForMinimumBuffer(mediaInfo,value,estimatedBandwidth,currentBufferLevel);
            }
        }
        return currentValue;
    }
    //to balance quality between current segment and next one
    function balanceQualityForNextSaliency(mediaInfo,value,lastValue,nextValue,currentBufferLevel,estimatedBandwidth,currentSaliency,nextSaliency){
        let i;
        let count=0;
        let currentValue=value;
        let currentQuality,nextQuality;
        let bufferLeft,bufferReserve;
        for (i = value; i > 0; i--) {
            if ((i - lastValue) * (value - lastValue) < 0) {
                currentValue = i + 1;
                break;
            }
            currentQuality = getQualityFromIndex(mediaInfo, i);
            bufferLeft = getEstimatedBufferLevel(currentBufferLevel, currentQuality, estimatedBandwidth);
            for (let k = nextValue; k >= 0; k--) {
                if(getQualityFromIndex(mediaInfo,i)<estimatedBandwidth*1000)
                {
                    if ((i - k) * (currentSaliency - nextSaliency) < 0)break;
                }else
                {
                    if ((i - k) * (currentSaliency - nextSaliency) <= 0)break;

                }
                count++;
                nextQuality = getQualityFromIndex(mediaInfo, k);
                bufferReserve = nextQuality * fragmentDuration / (estimatedBandwidth * 1000);
                log("Test by huaying:" + "count:" + count + "quality value:"+value+"bufferLeft in roundD:" + bufferLeft + "bufferReserve in" +
                    " roundD:" + bufferReserve + "currentValue:" + i + "nextValue:" + k);
                // if (bufferLeft >= bufferReserve && nextQuality<estimatedBandwidth*1000)return i;
                if (bufferLeft >= bufferReserve)return i;
            }
        }
        return currentValue;
    }
    //version:3
    function adjustQualityForNextSaliency(mediaInfo,lastSaliency,currentSaliency,nextSaliency,value,lastValue,estimatedBandwidth,currentBufferLevel,topQualityIndex){
        let currentValue=value;
        if(currentSaliency!=lastSaliency)
        {
            let nextValue=getInitialQualityForSailency(currentSaliency,nextSaliency,value,topQualityIndex);
            currentValue=balanceQualityForNextSaliency(mediaInfo,currentValue,lastValue,nextValue,currentBufferLevel,estimatedBandwidth,currentSaliency,nextSaliency);

        }
        return currentValue;
    }

    function adjustInitialQuality(mediaInfo,testValue,estimatedBandwidth,currentBufferLevel,lastSegmentSaliency,currentSegmentSaliency,nextSaliency,lastValue,topQualityIndex){
        let currentValue;
        //First,check if the initial assigned quality meets the current buffer,if not, adjust it
        currentValue= adjustQualityForCurrentBuffer(mediaInfo, testValue, estimatedBandwidth, currentBufferLevel);
        log("Test by huaying:" + "adjust 1:" + currentValue);
        //Second,check if the currentBuffer constrained quality meets the minimum buffer,if not,
        // adjust it
        currentValue = adjustQualityForMinimumBuffer(mediaInfo,currentValue, estimatedBandwidth, currentBufferLevel);
        log("Test by huaying:" + "adjust 2:" + currentValue);
        //Third,check if the current quality meets the saliency requirement for next segment,if
        // not,adjust it
        currentValue = adjustQualityForNextSaliency(mediaInfo, lastSegmentSaliency, currentSegmentSaliency, nextSaliency, currentValue, lastValue, estimatedBandwidth, currentBufferLevel,topQualityIndex);
        log("Test by huaying:" + "adjust 3:" + currentValue);
        return currentValue;
    }

    //version:3



    function reset() {
        eventBus.off(Events.VIDEO_SEND_REQUEST, onVideoSendRequest(), this);
        eventBus.off(Events.MDP_TRAIN, onMdpTrain(),this);
        setup();
    }

    var instance = {
        getMaxIndex: getMaxIndex,
        reset: reset
    };

    setup();
    return instance;
}


MdpPerceptualContentAwareRule.__dashjs_factory_name = 'MdpPerceptualContentAwareRule';
export default FactoryMaker.getClassFactory(MdpPerceptualContentAwareRule);

