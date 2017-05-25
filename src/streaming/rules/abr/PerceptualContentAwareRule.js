/**
 * Created by AimmeeXue on 2017/5/20.
 */
/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

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





function PerceptualContentAwareRule(config) {

    const context = this.context;
    const dashMetrics = config.dashMetrics;
    const metricsModel = config.metricsModel;
    const log = Debug(context).getInstance().log;


    let throughputArray,
        latencyArray,
        mediaPlayerModel,
        bufferStateDict,
        adapter,
        richBuffer,
        safeFactor,
        bufferAvailable,
	    fragmentDuration;

    function setup() {
        throughputArray = [];
        latencyArray = [];
        bufferStateDict={};
        mediaPlayerModel = MediaPlayerModel(context).getInstance();
        adapter = DashAdapter(context).getInstance();
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
                    return INFINITYBANDWIDTH;
                } else {
                    let deadTimeRatio = latency / fragmentDuration;
                    throughput = throughput * (1 - deadTimeRatio);
                    return throughput;
                }
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

    function needToKeepQuality(type,currentSegmentInfo,nextSegmentInfo){
        if(throughputArray[type]&&throughputArray[type].length>1) {
            const pastTwoThroughputArray = throughputArray[type].slice(-2, throughputArray[type].length);
            if (pastTwoThroughputArray.length > 1) {
                if (pastTwoThroughputArray[0] > pastTwoThroughputArray[1]) {
                    if (currentSegmentInfo.scene == nextSegmentInfo.scene) {
                        return true;
                    }
                }
            }
        }
        return false;
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


    function getQualityForVideo(mediaInfo,estimatedBandwidth,safeFactor,bufferAvailable) {
        var bitrate=estimatedBandwidth*bufferAvailable/(safeFactor*fragmentDuration);
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

    function getMaxIndex(rulesContext) {
        var estimatedBandwidth,currentBufferLevel;


        const mediaInfo = rulesContext.getMediaInfo();
        const mediaType = mediaInfo.type;
        const metrics = metricsModel.getReadOnlyMetricsFor(mediaType);
        const streamProcessor = rulesContext.getStreamProcessor();
        const abrController = streamProcessor.getABRController();
        const bufferController = streamProcessor.getBufferController();
        const isDynamic = streamProcessor.isDynamic();
        const lastRequest = dashMetrics.getCurrentHttpRequest(metrics);
        const bufferStateVO = (metrics.BufferState.length > 0) ? metrics.BufferState[metrics.BufferState.length - 1] : null;
        const hasRichBuffer = rulesContext.hasRichBuffer();
        const switchRequest = SwitchRequest(context).create();

        if (!metrics || !lastRequest || lastRequest.type !== HTTPRequest.MEDIA_SEGMENT_TYPE || !bufferStateVO || hasRichBuffer) {
            return switchRequest;
        }

        setBufferInfo(mediaType, bufferStateVO.state);

        //get the estimated bandwidth
        estimatedBandwidth = getEstimatedBandwidth(mediaType,lastRequest, streamProcessor,isDynamic,abrController);
        //To avoid the buffer underrun:consider the long latency case
        if (estimatedBandwidth == INFINITYBANDWIDTH) {
            switchRequest.value = 0;
            switchRequest.reason = 'The latency is too long.';
        } else {
            //To avoid the buffer underrun:consider the insufficient buffer case
            currentBufferLevel = bufferController.getBufferLevel();
            if (bufferStateVO.state === BufferController.BUFFER_EMPTY && bufferStateDict[mediaType].firstBufferLoadedEvent !== undefined) {
                switchRequest.value = 0;
                switchRequest.reason = 'Buffer is empty';
            } else {
                if (mediaType == 'video') {
                    //get the next segmentInfo:scene and importance
                    var currentSegmentIndex = streamProcessor.getIndexHandler().getCurrentIndex();
                    var currentSegmentInfo = adapter.getSegmentImportance()[currentSegmentIndex];
                    var nextSegmentInfo = adapter.getSegmentImportance()[currentSegmentIndex + 1];
                    //To avoid the quality oscillation: consider the same scene case
                    if (needToKeepQuality(mediaType, currentSegmentInfo, nextSegmentInfo)) {
                        switchRequest.reason = 'Keep the same quality';
                    }
                    //To consider the segment importance as well as avoid the buffer underrun
                    //get the segment importance and assign the safeFactor and available buffer resource
                    //TODO:modify the data structure
                    richBuffer = abrController.getRichBuffer();
                    if (currentBufferLevel < 0.6 * richBuffer) {
                        switch (nextSegmentInfo.importance) {
                            case 4:
                            case 5:
                                safeFactor = 1.4;
                                bufferAvailable = 0.4*currentBufferLevel;
                                break;
                            case 6:
                            case 7:
                                safeFactor = 1.6;
                                bufferAvailable = 0.6*currentBufferLevel;
                                break;
                            case 8:
                            case 9:
                            case 10:
                                safeFactor = 1.8;
                                bufferAvailable = 0.8*currentBufferLevel;
                                break;
                            default:
                                safeFactor=1.8;
                                bufferAvailable=currentBufferLevel;
                        }
                    } else {
                        switch (nextSegmentInfo.importance) {
	                        case 4:
	                        case 5:
                                safeFactor = 1.1;
                                bufferAvailable = 0.2*currentBufferLevel;
                                break;
	                        case 6:
	                        case 7:
                                safeFactor = 1.2;
                                bufferAvailable = 0.5*currentBufferLevel;
                                break;
	                        case 8:
	                        case 9:
	                        case 10:
                                safeFactor = 1.3;
                                bufferAvailable = 0.7*currentBufferLevel;
                                break;
	                        default:
		                        safeFactor=1.4;
		                        bufferAvailable=currentBufferLevel;
                        }
                    }
                    //choose the video quality
                    switchRequest.value = getQualityForVideo(mediaInfo, estimatedBandwidth,safeFactor,bufferAvailable);
                    switchRequest.reason = 'safeFactor:'+ safeFactor+ 'bufferAvailable:'+ bufferAvailable;
                }else if(mediaType=='audio'){
                    //choose the audio quality
                    switchRequest.value = getQualityForAudio(mediaInfo, estimatedBandwidth);
                    switchRequest.reason = 'Only throughput rule for audio'+'estimatedBandwidth:'+estimatedBandwidth;
                    }
                }
            }
            //start to load
            if (abrController.getAbandonmentStateFor(mediaType) !== AbrController.ABANDON_LOAD) {
                if (bufferStateVO.state === BufferController.BUFFER_LOADED || isDynamic) {
                    streamProcessor.getScheduleController().setTimeToLoadDelay(0);
                    log('PerceptualContentAwareRule requesting switch to index: ', switchRequest.value, 'type: ', mediaType, 'estimated bandwidth', Math.round(estimatedBandwidth), 'kbps', 'buffer', currentBufferLevel, 'switch reason', switchRequest.reason);

                }

            }
            return switchRequest;
        }
    


    function reset() {
        setup();
    }

    var instance = {
        getMaxIndex: getMaxIndex,
        reset: reset
    };

    setup();
    return instance;
}


PerceptualContentAwareRule.__dashjs_factory_name = 'PerceptualContentAwareRule';
export default FactoryMaker.getClassFactory(PerceptualContentAwareRule);
