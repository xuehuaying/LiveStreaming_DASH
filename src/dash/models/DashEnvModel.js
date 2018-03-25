/**
 * Created by Aimmee Xue on 2018/2/28.
 */
/**
 * Class:DashEnvModel
 * This class is to describe the DASH adaptive streaming environment. It is used for the MdpPerceptualContentAwareRule.
 * Now we solve the MdpPerceptualContentAwareRule as a deterministic,finite Markov Decision Process(MDP).
 * So we can use dynamic programming to solve the optimization problem.
 * DashEnvModel can be explicitly defined offline.
 * */
import FactoryMaker from '../../core/FactoryMaker';
import DashAdapter from '../DashAdapter';
import DashManifestModel from './DashManifestModel';
import MdpState from '../vo/MdpState';
import Debug from '../../core/Debug';

const LAMDA = 1.5;
const E = 1.5;
const SLEEP_INTERVAL = 500;


function DashEnvModel() {
	let instance;
	let context = this.context;
	let adaptor = DashAdapter(context).getInstance();
	let dashManifestModel=DashManifestModel(context).getInstance();
    let step;
    let startSegIndex;
    let sk_min;
    let sk_max;
    let mk_min;
    let mk_max;
    const log = Debug(context).getInstance().log;

	var q,
		m,
		states,
		R_MAX,
		R_MIN,
		R_STABLE,
		R_TARGET,
		qualityDict,
		shotInfo = [],
		saliencyInfo = [],
        saliencyList,
        maxSa,
		segmentDuration;//q:quality count  m:segment count to be calculated

	function initialize(config) {
		var streamProcessor=config.streamProcessor;
		var manifest=config.manifest;
		var initialBandwidth = config.bandwidth;
		var initialBuffer = config.buffer;

		var mediaInfo = streamProcessor.getMediaInfo();
		var adaptation=adaptor.getDataForMedia(mediaInfo);

        var initQualityIndex = config.initQualityIndex;

		var representations;//sorted in the ascending order
		var shotsList;

        step = config.segmentStep;
        startSegIndex = config.startSegment;
		R_MAX = config.R_MAX;
		R_MIN = config.R_MIN;
		R_TARGET = config.R_TARGET;
		R_STABLE = config.R_STABLE;

		q = mediaInfo.representationCount;
		m = dashManifestModel.getSegmentCountForAdaptation(manifest,adaptation);
        segmentDuration = streamProcessor.getCurrentRepresentationInfo().fragmentDuration;
        representations = dashManifestModel.getRepresentationsForAdaptation(manifest,adaptation);
        qualityDict = [];
		for(var i = 0;i < representations.length;i++)
			qualityDict.push(representations[i].bandwidth / 1000);
		shotsList = adaptor.getShotsList();
		saliencyList = adaptor.getSaliencyClass();
		changeToShotInfo(shotsList);
        refineSaliencyList(initialBandwidth);
		changeToSaliencyInfo();
        states = constructStates(initialBandwidth, initialBuffer, initQualityIndex);

        // calculate min and max reward for each kind
        sk_min = 0;
        sk_max = ((R_MAX-R_MIN)/2)*(R_MAX-R_MIN)/2;
        mk_min = [];
        mk_max = [];

        maxSa = 0;
        for(var k = 0; k < saliencyList.length; k++)
            maxSa = Math.max(maxSa, saliencyList[k]);
        for(var p = 1; p <= maxSa; p++){
            mk_min.push(getQualityReward(0, p));
            mk_max.push(getQualityReward(q-1, p));
        }
    }

	function getNumStates(){
		return (Math.pow(q,step+1)-1)/(q-1);
	}

	function getMaxNumActions(){
		return q;
	}

	//input:index@state
	function allowedActions(index){
		var segmentIndex = sToSegmentIndex(index);
		var as = [];
		if(segmentIndex != startSegIndex + step - 1){
			for(var i = 0;i < q;i++ ){
				as.push(i);
			}
		}
		return as;
	}

	//input:index@state
	//right now, we assume the deterministic MDPs (meet with rl.js library)
	//so return a single integer that identifies the next state of the env
	function nextStateDistribution(index,a){
		return index * q + a + 1;
	}

	function reward(index,action,nextIndex){
		var state = states[index];
		var nextState = states[nextIndex];
		var curBuffer = state.buffer;
		var r_sk = getNormalizedSmoothnessReward(nextState.buffer);
		var r_dk = getNormalizedSwitchingReward(state,action,nextState);
		var r_mk = getNormalizedQualityReward(action, saliencyList[sToSegmentIndex(nextIndex)]);
		var a,b,c;
		if(curBuffer > R_MAX){
			a = 0.4;
			b = 0.2;
			c = 0.4;
		}else if(curBuffer < R_MIN){
			a = 0.9;
			b = 0.05;
			c = 0.05;
		}else if(curBuffer < R_TARGET){
			a = 0.6;
			b = 0.3;
			c = 0.1;
		}else {
		    a = 0.2;
		    b = 0.5;
		    c = 0.3;
        }

        return r_sk + r_dk + r_mk;
		 // return a * r_sk + b * r_dk + c * r_mk;
    }

	/*auxiliary functions
	*
	*
	* **/
	function getBaseLog(x,y){
		return Math.log(y) / Math.log(x);
	}

	function sToSegmentIndex(index){
		return Math.floor(getBaseLog(q,index * (q - 1) + 1)) - 1 + startSegIndex;
	}

	function constructStates(initialBandwidth, initialBuffer, initQualityIndex){
		var statesNum = getNumStates();
		var states = [];

		var state_0 = new MdpState();
		state_0.buffer = initialBuffer;
		state_0.bandwidth = initialBandwidth;
		state_0.bitrateVector = [initQualityIndex];
		state_0.p = shotInfo[startSegIndex-1];
		state_0.s = saliencyInfo[startSegIndex-1];
		states.push(state_0);

		for(var i = 1;states.length < statesNum; i++){
			var sleepMode = states[i - 1].buffer > R_TARGET ? 1 : 0;
			var actions = allowedActions(i - 1);

			for(var j = 0;j < actions.length; j++){
				var action = actions[j];
				var quality = qualityDict[action];

				var state_i = new MdpState();
				state_i.bandwidth = initialBandwidth;
				if(sleepMode)
					state_i.buffer = states[i - 1].buffer + segmentDuration - quality / state_i.bandwidth * segmentDuration - SLEEP_INTERVAL/1000;
				else
					state_i.buffer = states[i - 1].buffer + segmentDuration - quality / state_i.bandwidth * segmentDuration;
				if(states[i - 1].p == 1)
					state_i.bitrateVector = [action];
				else
					state_i.bitrateVector = states[i - 1].bitrateVector.concat(action);
				state_i.p = shotInfo[sToSegmentIndex(states.length)];
				state_i.s = saliencyInfo[sToSegmentIndex(states.length)];
				states.push(state_i);
			}
		}

		return states;
	}

	function getNormalizedSmoothnessReward(nextBuffer){
	    if(nextBuffer < R_MIN){
	        return nextBuffer - R_MIN;
        } else if(nextBuffer > R_MAX){
	        return R_MAX - nextBuffer;
        }

	    var sk = (nextBuffer-R_MIN)*(R_MAX-nextBuffer);
        return getNormalizedReward(sk, sk_min, sk_max);
	}

	function getNormalizedSwitchingReward(state,a,nextState){
	    var nextSaliency = nextState.s;
		var r_dk;
		var cur_dkmax;
        var expectedQualityIndex = state.bitrateVector[state.bitrateVector.length-1];
        var curQuality = qualityDict[a];

        if(state.p == 1){
            expectedQualityIndex = Math.max(0, Math.min(qualityDict.length - 1, expectedQualityIndex + nextSaliency));
		}
        var expectedQuality = qualityDict[expectedQualityIndex];

        r_dk = Math.log(Math.abs((qualityDict[expectedQualityIndex]-curQuality)*1000) + E);

        cur_dkmax = Math.abs(expectedQuality-qualityDict[0]) > Math.abs(expectedQuality-qualityDict[qualityDict.length-1]) ?
            Math.log(Math.abs((expectedQuality-qualityDict[0])*1000) + E) : Math.log(Math.abs((expectedQuality-qualityDict[qualityDict.length-1])*1000) + E);
		return 1 - getNormalizedReward(r_dk, 0, cur_dkmax);
	}

	function getQualityReward(qualityIndex, saliency){
        return Math.log(Math.pow(qualityDict[qualityIndex]*1000+ E,saliency));
	}

	function getNormalizedQualityReward(qualityIndex, saliency) {
	    var factor = saliency/maxSa;
        return factor*getNormalizedReward(getQualityReward(qualityIndex, saliency), mk_min[saliency-1], mk_max[saliency-1]);
    }

	function getNormalizedReward(value, min, max) {
        return (value - min)/(max - min);
    }
	function changeToShotInfo(shotsList){
		var cnt = 1;
		var length = shotsList.length;
		shotInfo[length - 1] = cnt;
		for(var i = 1;i < length ; i++){
			if(shotsList[length - 1 - i] == shotsList[length - i]){
				cnt++;
			}else{
				cnt = 1;
			}
			shotInfo[length - 1 - i] = cnt;
		}
	}

	function refineSaliencyList(initialBandwidth) {
        // first, we will refine the saliencyList according to current bandwidth and bitrate list
        var maxAvaQualityIndex = 0;
        for (var m = 0; m < qualityDict.length; m++ ){
            if(initialBandwidth*1.3 > qualityDict[m])
                maxAvaQualityIndex = m;
        }
        var topSaClass = maxAvaQualityIndex + 1;
        var curTopSa = 0;
        for (var n = 0; n < saliencyList.length; n++){
            curTopSa = Math.max(curTopSa, saliencyList[n]);
        }
        // refine saliencyList
        for (var i = 0; i < saliencyList.length; i++){
            saliencyList[i] = Math.round(saliencyList[i]*topSaClass/curTopSa);
        }
    }

	function changeToSaliencyInfo(){
        var delta = 0;
        var length = saliencyList.length;
        saliencyInfo[0] = delta;
        for(var i = 1; i < length; i++){
            delta = saliencyList[i] - saliencyList[i - 1];
            saliencyInfo.push(delta);
        }
	}

    function updateSegParameter(step, start) {
        this.step = step;
        this.startSegment = start;
    }

    function getStartStateIndexForSegment(segmentIndex, qualityNum){
	    if(segmentIndex - startSegIndex < 0)
	        return 0;
        return (Math.pow(qualityNum,segmentIndex-startSegIndex+1)-1)/(qualityNum-1);
    }

	instance = {
		initialize:initialize,
		getNumStates:getNumStates,
		getMaxNumActions:getMaxNumActions,
		allowedActions:allowedActions,
		nextStateDistribution:nextStateDistribution,
		reward:reward,
        updateSegParameter:updateSegParameter,
        getStartStateIndexForSegment:getStartStateIndexForSegment
	};

	return instance;
}

DashEnvModel.__dashjs_factory_name = 'DashEnvModel';
export default FactoryMaker.getSingletonFactory(DashEnvModel);
