/**
 * Created by AimmeeXue on 2018/3/3.
 */

/*
MdpPerceptualContentAwareRule is to use MDP model and DPAgent to get a switchRequest.
It can be divided into two parts -- offline trainer and online runner.
* **/

import DashEnvModel from '../../../dash/models/DashEnvModel';
import DPAgent from '../../../../mytest/app/lib/reinforcementLearning/DPAgent';
import ManifestUpdater from '../../ManifestUpdater';

import EventBus from '../../../core/EventBus';
import Events from '../../../core/events/Events';
import FactoryMaker from '../../../core/FactoryMaker';
import SwitchRequest from '../SwitchRequest.js';
import {HTTPRequest} from '../../vo/metrics/HTTPRequest';
import AbrController from '../../controllers/AbrController';
import BufferController from '../../controllers/BufferController';
import Debug from '../../../core/Debug';
import MediaPlayerModel from '../../models/MediaPlayerModel';
import BitrateInfo from '../../vo/BitrateInfo';
import * as MyDashConstants from '../../../dash/constants/MyDashConstants';

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
const MIN_BUFFER=4;
const R_TARGET= 12;


const MAX_ROUND = 1000;
const MAX_ERROR = 0.0;





function MdpPerceptualContentAwareRule() {

    const context = this.context;
    const agent = DPAgent(context).getInstance();

    const log = Debug(context).getInstance().log;
    const eventBus = EventBus(context).getInstance();



    let mdpSwitch,
        dashEnvModel,
        throughputArray,
        latencyArray,
        estimatedBandwidthArray,
        abrController,
        bufferController,
        mediaPlayerModel,
        manifestUpdater,
        requestQualityHistory,
        startIndex,
        preSegIndex,
        preQuality,
        metrics,
        fragmentDuration,
        optimalPolicy,
        streamProcessor,
        dashMetrics,
        metricsModel,
        minAvailiableSegIndex,
        maxAvailiableSegIndex;

    function initialize(streamprocessor,dashmetrics,metricsmodel){
        streamProcessor = streamprocessor;
        dashMetrics = dashmetrics;
        metricsModel = metricsmodel;
        abrController = streamProcessor.getABRController();
        bufferController = streamProcessor.getBufferController();
        metrics = metricsModel.getReadOnlyMetricsFor('video');
        // const bufferState = (metrics.BufferState.length > 0) ? metrics.BufferState[metrics.BufferState.length - 1] : null;
        // if(bufferState){
        //     R_TARGET = bufferState.target;
        // }
    }

    function setup() {
        mdpSwitch = false;
        throughputArray = [];
        latencyArray = [];
        estimatedBandwidthArray=[];
        requestQualityHistory=[];
        optimalPolicy = [];
        startIndex = 0;
        preSegIndex = 0;
        preQuality = 0;
        dashEnvModel = DashEnvModel(context).getInstance();
        mediaPlayerModel = MediaPlayerModel(context).getInstance();
        manifestUpdater = ManifestUpdater(context).getInstance();
        minAvailiableSegIndex = 0;
        maxAvailiableSegIndex = 0;

        eventBus.on(Events.VIDEO_SEND_REQUEST, onVideoSendRequest, this);
        eventBus.on(Events.MDP_TRAIN, onMdpTrain, this);
    }


    /*
     Offline Training
     * **/
    function onMdpTrain(e){
        var initialBuffer = bufferController.getBufferLevel();
        mdpSwitch = true;
            dashEnvModel.initialize({
                streamProcessor: streamProcessor,
                manifest: manifestUpdater.getManifest(),
                bandwidth:estimatedBandwidthArray[estimatedBandwidthArray.length-1],
                buffer:initialBuffer,
                R_MAX:abrController.getRichBuffer(),
                R_MIN:MIN_BUFFER,
                R_TARGET:R_TARGET,
                R_STABLE:mediaPlayerModel.getStableBufferTime(),
                segmentStep:MyDashConstants.MDP_SEGMENT_COUNT,
                startSegment:e.segIndex,
                initQualityIndex:preQuality
            });
        log("bandwidth: " + estimatedBandwidthArray[estimatedBandwidthArray.length-1] + " preQuality:" + preQuality + "initBuffer:" + initialBuffer);

        agent.initialize({env:dashEnvModel,opt:{'gamma':0.9}});

        var policy = [];
        var lastPolicy = [];
        var roundCnt = 0;
        var MSEError = Number.POSITIVE_INFINITY;
        while(MSEError > MAX_ERROR && roundCnt <= MAX_ROUND){
            agent.learn();
            policy = agent.getPolicy();
            roundCnt ++;
            MSEError = getMSEFromArray(lastPolicy,policy);
            log("mse error:"+MSEError);
            // lastPolicy = [];
            // lastPolicy = policy.concat();
            // lastPolicy = policy;
            for (var i = 0; i < policy.length; i++)
            {
                lastPolicy[i] = policy[i];
            }
        }
        optimalPolicy = policy;
        minAvailiableSegIndex = e.segIndex;
        maxAvailiableSegIndex = e.segIndex + MyDashConstants.MDP_SEGMENT_COUNT - 1;
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
            var ns = dashEnvModel.getNumStates();
            var curSegmentIndex = streamProcessor.getIndexHandler().getCurrentIndex();

            log("min: "+minAvailiableSegIndex+"cur: "+curSegmentIndex+"max: "+maxAvailiableSegIndex);
            updateBandwidthArray(mediaType,lastRequest,streamProcessor,isDynamic,abrController);
            if(!mdpSwitch){
                switchRequest.value = 0;
                switchRequest.reason = 'Default quality from the beginning stage!';
            }else{
                var maxQuality = 0;
                var maxPoss = 0;

                log("add by menglan, index:" + curSegmentIndex + " maxAvailiableSegIndex:" + maxAvailiableSegIndex);

                if (curSegmentIndex + 1 < minAvailiableSegIndex){
                    maxQuality = 0;
                    log("curSegIndex < minAvailiable, select 0");
                } else if (curSegmentIndex + 1 > maxAvailiableSegIndex){
                    maxQuality = 0;
                    log("add by menglan: select -1 ");
                } else{
                    if(curSegmentIndex + 1 == minAvailiableSegIndex) {
                        startIndex = 0;
                    }else if(preSegIndex != curSegmentIndex){
                        startIndex = dashEnvModel.nextStateDistribution(startIndex,preQuality);
                    }

                    for (var i = 0; i < qualityNum; i++) {
                        log("startIndex:" + startIndex);
                        log("possibility: " + optimalPolicy[startIndex + i*ns]);
                        if (optimalPolicy[startIndex + i*ns] > maxPoss) {
                            maxPoss = optimalPolicy[startIndex+i*ns];
                            maxQuality = i;
                        }
                    }
                }
                switchRequest.value = maxQuality;
                switchRequest.reason = 'get max quality from mdp trained result';
            }
            preSegIndex = curSegmentIndex;
            preQuality = switchRequest.value;
        }else if(mediaType=='audio'){
            //choose the audio quality
            switchRequest.value = getQualityForAudio(mediaInfo, estimatedBandwidthArray[estimatedBandwidthArray.length-1]);
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








    function reset() {
        eventBus.off(Events.VIDEO_SEND_REQUEST, onVideoSendRequest(), this);
        eventBus.off(Events.MDP_TRAIN, onMdpTrain(),this);
        setup();
    }

    var instance = {
        getMaxIndex: getMaxIndex,
        initialize:initialize,
        reset: reset
    };

    setup();
    return instance;
}


MdpPerceptualContentAwareRule.__dashjs_factory_name = 'MdpPerceptualContentAwareRule';
export default FactoryMaker.getSingletonFactory(MdpPerceptualContentAwareRule);

