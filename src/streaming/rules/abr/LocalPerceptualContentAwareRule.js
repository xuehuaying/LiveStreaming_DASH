/**
 * Created by Aimmee Xue on 2017/7/4.
 */
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





function LocalPerceptualContentAwareRule(config) {

	const context = this.context;
	const dashMetrics = config.dashMetrics;
	const metricsModel = config.metricsModel;
	const version=config.version;
	const log = Debug(context).getInstance().log;

    const eventBus = EventBus(context).getInstance();

	let throughputArray,
		latencyArray,
		mediaPlayerModel,
		bufferStateDict,
		adapter,
		fragmentDuration,
		estimatedBandwidthArray,
		//version:3
        requestQualityHistory;

	function setup() {
		throughputArray = [];
		latencyArray = [];
		estimatedBandwidthArray=[];
		//version:3;
		bufferStateDict={};
        requestQualityHistory=[];
		mediaPlayerModel = MediaPlayerModel(context).getInstance();
		adapter = DashAdapter(context).getInstance();
        eventBus.on(Events.VIDEO_SEND_REQUEST, onVideoSendRequest, this);
	}

    function onVideoSendRequest(e) {
        if (e.error) return;
        log("add by menglan, index:" + e.index + " quality:" + e.quality);
        requestQualityHistory.push(e.quality);
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


	function getAverageLatency(mediaType) {
		let average;
		if (latencyArray[mediaType] && latencyArray[mediaType].length > 0) {
			average = latencyArray[mediaType].reduce((a, b) => { return a + b; }) / latencyArray[mediaType].length;
		}

		return average;
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

	function getEstimatedBandwidth(mediaType,lastRequest,streamProcessor,isDynamic,abrController) {

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
				return throughput;
			}
		}
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
	function getMaxIndex(rulesContext) {
		let estimatedBandwidth,currentBufferLevel;


		const mediaInfo = rulesContext.getMediaInfo();
        const topQualityIndex=rulesContext.getTopQualityIndex();
		const mediaType = mediaInfo.type;
		const metrics = metricsModel.getReadOnlyMetricsFor(mediaType);
		const streamProcessor = rulesContext.getStreamProcessor();
		const abrController = streamProcessor.getABRController();
		const bufferController = streamProcessor.getBufferController();
		const isDynamic = streamProcessor.isDynamic();
		const lastRequest = dashMetrics.getCurrentHttpRequest(metrics);
		const bufferStateVO = (metrics.BufferState.length > 0) ? metrics.BufferState[metrics.BufferState.length - 1] : null;
		const switchRequest = SwitchRequest(context).create();

		if (!metrics || !lastRequest || lastRequest.type !== HTTPRequest.MEDIA_SEGMENT_TYPE || !bufferStateVO) {
			return switchRequest;
		}
		//get the current buffer level
		currentBufferLevel = bufferController.getBufferLevel();
		setBufferInfo(mediaType, bufferStateVO.state);
		//get the estimated bandwidth
		estimatedBandwidth = getEstimatedBandwidth(mediaType,lastRequest, streamProcessor,isDynamic,abrController);
		//To avoid the buffer underrun:consider the long latency case
		if (estimatedBandwidth == INFINITYBANDWIDTH) {
			switchRequest.value = 0;
			switchRequest.reason = 'The latency is too long.';
		} else {
			//To avoid the buffer underrun:consider the insufficient buffer case
			if (currentBufferLevel<INSUFFICIENT_BUFFER) {
				switchRequest.value = 0;
				switchRequest.reason = 'Buffer is insufficient';
			} else {
				if (mediaType == 'video') {
					//get the saliency level of the last segment, current segment and next segment
					//get the switchRequestValue of the last segment
					let lastSegmentIndex = streamProcessor.getIndexHandler().getCurrentIndex();
					let currentSegmentIndex = lastSegmentIndex+1;
					let lastSegmentSaliency = adapter.getSaliencyClass()[lastSegmentIndex];
					let currentSegmentSaliency = adapter.getSaliencyClass()[currentSegmentIndex];
					let len,lastValue,initialValue,adjustedValue;
					let nextSaliency=getNextSaliency(1);
					if(currentSegmentIndex && currentSegmentSaliency!=lastSegmentSaliency){
						nextSaliency=getNextSaliency(currentSegmentIndex);
						log("Test by huaying:next saliency:"+nextSaliency+";"+"current saliency:"+currentSegmentSaliency);
					}

                    if (requestQualityHistory){
                        len = requestQualityHistory.length;
                        lastValue = requestQualityHistory[len - 1];
                        log("add by menglan: lastvalue: " + lastValue);
                    }
					if(currentSegmentSaliency) {
						if (nextSaliency) {
							//get the initial quality by last segment saliency and adjust it
							initialValue = getInitialQualityForSailency(lastSegmentSaliency, currentSegmentSaliency, lastValue, topQualityIndex);
							log("Test by huaying:" + "initial quality:" + initialValue);
							adjustedValue = adjustInitialQuality(mediaInfo, initialValue, estimatedBandwidth, currentBufferLevel, lastSegmentSaliency, currentSegmentSaliency, nextSaliency, lastValue, topQualityIndex);
							if(version == 2){
								let testValue = initialValue;
								//try to raise the quality
								if (lastSegmentSaliency&&currentSegmentSaliency != lastSegmentSaliency) {
									while (testValue == adjustedValue && testValue<topQualityIndex) {
										testValue++;
										log("Test by huaying:test quality:"+testValue);
										if(getQualityFromIndex(mediaInfo,testValue)<estimatedBandwidth*1000){
											adjustedValue = adjustInitialQuality(mediaInfo, testValue, estimatedBandwidth, currentBufferLevel, lastSegmentSaliency, currentSegmentSaliency, nextSaliency, lastValue, topQualityIndex);
										}
									}
								}
							}
							log("Test by huaying:final quality:"+adjustedValue);
							switchRequest.value = adjustedValue;
							switchRequest.reason = "SaliencyRule:" + "estimated bandwidth" + Math.round(estimatedBandwidth) + "kbps" + "buffer:" + currentBufferLevel;
						} else {
							switchRequest.value = getQualityForVideo(mediaInfo, estimatedBandwidth, currentBufferLevel);
							switchRequest.reason = "LastSceneRule";
						}
					}
				}else if(mediaType=='audio'){
					//choose the audio quality
					switchRequest.value = getQualityForAudio(mediaInfo, estimatedBandwidth);
					switchRequest.reason = 'Only throughput rule for audio'+'estimatedBandwidth:'+estimatedBandwidth;
				}
			}
		}
		//start to load:if the buffer is not empty, use this way to load for you can set the time delay
		if (abrController.getAbandonmentStateFor(mediaType) !== AbrController.ABANDON_LOAD) {
			if (bufferStateVO.state === BufferController.BUFFER_LOADED || isDynamic) {
				streamProcessor.getScheduleController().setTimeToLoadDelay(0);
				log( 'type: ', mediaType,'PerceptualContentAwareRule requesting switch to index: ', switchRequest.value,"switch reason:", switchRequest.reason);
			}

		}


		return switchRequest;
	}



	function reset() {
        eventBus.off(Events.VIDEO_SEND_REQUEST, onVideoSendRequest(), this);
        setup();
	}

	var instance = {
		getMaxIndex: getMaxIndex,
		reset: reset
	};

	setup();
	return instance;
}


LocalPerceptualContentAwareRule.__dashjs_factory_name = 'LocalPerceptualContentAwareRule';
export default FactoryMaker.getClassFactory(LocalPerceptualContentAwareRule);
