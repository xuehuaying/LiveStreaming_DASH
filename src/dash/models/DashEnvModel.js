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
import DashManifestModel from 'DashManifestModel';
import MdpState from '../vo/MdpState';

const BANDWIDTH_SMOOTH_LEVEL = 4;
const LAMDA = 1.5;
const E = 1.5;
const SLEEP_INTERVAL = 500;


function DashEnvModel() {
	let instance;
	let context = this.context;
	let adaptor = DashAdapter(context).getInstance();
	let dashManifestModel=DashManifestModel(context).getInstance();

	var q,
		m,
		states,
		R_MAX,
		R_MIN,
		R_STABLE,
		R_TARGET,
		qualityDict = [],
		shotInfo = [],
		saliencyInfo = [],
		segmentDuration;//q:quality count  m:segment count to be calculated

	function initialize(config) {
		var streamProcessor=config.streamProcessor;
		var manifest=config.manifest;
		var initialBandwidth = config.bandwidth;
		var initialBuffer = config.buffer;

		var mediaInfo = streamProcessor.getMediaInfo();
		var adaptation=adaptor.getDataForMedia(mediaInfo);
		var representations;//sorted in the ascending order
		var shotsList;
		var saliencyList;

		states = constructStates(initialBandwidth, initialBuffer);
		R_MAX = config.R_MAX;
		R_MIN = config.R_MIN;
		R_TARGET = config.R_TARGET;
		R_STABLE = config.R_STABLE;

		q = mediaInfo.representationCount;
		m = dashManifestModel.getSegmentCountForAdaptation(manifest,adaptation)-BANDWIDTH_SMOOTH_LEVEL + 1;
		representations = dashManifestModel.getRepresentationsForAdaptation(manifest,adaptation);
		for(var i = 0;i < representations.length;i++)
			qualityDict.push(representations[i].bandwidth);
		shotsList = DashAdapter.getShotsList();
		saliencyList = DashAdapter.getSaliencyList();
		changeToShotInfo(shotsList);
		changeToSaliencyInfo(saliencyList);
		//TODO:get segmentDuration
		segmentDuration = dashManifestModel.getSegmentDuration();

	}

	function getNumStates(){
		return (Math.pow(q,m)-1)/(q-1);
	}

	function getMaxNumActions(){
		return q;
	}

	//input:index@state
	function allowedActions(index){
		var segmentIndex = sToSegmentIndex(index);
		var as = [];
		if(segmentIndex != m-1){
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
		var nextBuffer = nextState.buffer;
		var r_sk = getSmoothnessReward(nextState.buffer);
		var r_dk = getSwitchingReward(state,action,nextState);
		var r_mk = getQualityReward(nextState);
		var a,b,c;
		if(nextBuffer > R_MAX){
			a = 0.4;
			b = 0.2;
			c = 0.4;
		}else if(nextBuffer < R_MIN){
			a = 0.8;
			b = 0.1;
			c = 0.1;
		}else{
			a = 0.2;
			b = 0.4;
			c = 0.4;
		}
		return a * r_sk + b * r_dk + c * r_mk;
	}



	/*auxiliary functions
	*
	*
	* **/
	function getBaseLog(x,y){
		return Math.log(y) / Math.log(x);
	}

	function sToSegmentIndex(index){
		return Math.floor(getBaseLog(q,index * (q - 1) + 1));
	}

	function getAverageQuality(s){
		var bitrateVector = s.bitrateVector;
		var sum = 0, averageQuality = 0;
		var length = bitrateVector.length;
		if (length){
			for(var i = 0;i < length;i++){
				var index = bitrateVector[i];
				sum += qualityDict[index];
			}
			averageQuality = sum/length;
		}
		return averageQuality;
	}

	function getQualityIndexFor(quality,bitrateVector){
		for(var i = 0;i < length;i++){
			if (quality < bitrateVector[i]) return i-1;
		}
		if(quality == bitrateVector[length-1])return length-1;
	}

	function getStandardDeviation(s){
		var bitrateVector = s.bitrateVector;
		var averageQuality = getAverageQuality(s);
		var length = bitrateVector.length;
		var standardDev = 0;
		if(length > 1){
			standardDev = Math.sqrt(bitrateVector.reduce(function (prev,cur){
				return prev + Math.pow(qualityDict[cur]-averageQuality,2);
			},0 )/(length-1));
		}
		return standardDev;
	}

	function constructStates(initialBandwidth, initialBuffer){
		var statesNum = getNumStates();
		var states = [];
		var startSegment = BANDWIDTH_SMOOTH_LEVEL - 1;

		var state_0 = new MdpState();
		state_0.buffer = initialBuffer;
		state_0.bandwidth = initialBandwidth;
		state_0.bitrateVector = [0];
		state_0.p = shotInfo[startSegment];
		state_0.s = saliencyInfo[startSegment];
		states.push(state_0);

		for(var i = 1;states.length < statesNum; i++){
			var sleepMode = states[i - 1].buffer > R_TARGET ? 1 : 0;
			var actions = allowedActions(i - 1);

			for(var j = 0;j < actions.length; j++){
				var action = actions[j];

				var state_i = new MdpState();
				state_i.throughput = initialBandwidth;
				if(sleepMode)
					state_i.buffer = states[i - 1].buffer + segmentDuration - action / state_i.throughput * segmentDuration - SLEEP_INTERVAL;
				else
					state_i.buffer = states[i - 1].buffer + segmentDuration - action / state_i.throughput * segmentDuration;
				if(states[i - 1].p == 1)
					state_i.bitrateVector = [action];
				else
					state_i.bitrateVector = states[i - 1].bitrateVector.concat(action);
				state_i.p = shotInfo[sToSegmentIndex(states.length) + startSegment];
				state_i.s = saliencyInfo[sToSegmentIndex(states.length) + startSegment];
				states.push(state_i);
			}
		}

		return states;
	}

	function getSmoothnessReward(nextBuffer){
		var r_sk;
		if(nextBuffer > R_MAX){
			r_sk = R_MAX - nextBuffer;
		}else if(nextBuffer < R_MIN){
			r_sk = nextBuffer - R_MIN;
		}else {
			r_sk = -Math.abs(R_STABLE - nextBuffer);
		}
		return r_sk;
	}

	function getSwitchingReward(state,a,nextState){
		var nextSaliency = nextState.s;
		var nextBuffer = nextState.buffer;
		var standardDev = 0;
		var r_dk;
		if(state.p == 1){
			var delta, dk;
			var averageQuality = getAverageQuality(state);
			var avgQualityIndex = getQualityIndexFor(averageQuality,state.bitrateVector);

			delta = a - avgQualityIndex;
			dk = Math.pow(Math.abs(delta - nextSaliency), 3);
			if(nextBuffer > R_MAX){
				if(delta * nextSaliency > 0 || (delta === 0 && nextSaliency === 0)){
					if(Math.abs(delta) > nextSaliency){
						r_dk = LAMDA * Math.log(dk + E);
					}else{
						r_dk = Math.log(dk + E);
					}
				}else{
					r_dk = -Math.log(dk + E);
				}
			}else{
				if(delta * nextSaliency > 0 || (delta === 0 && nextSaliency === 0))
					r_dk = -Math.log(dk + E);
				else r_dk = -LAMDA* Math.log(dk + E);
			}
		}else{
			standardDev = getStandardDeviation(nextState);
			r_dk = -Math.log(standardDev + E);
		}
		return r_dk;
	}

	function getQualityReward(nextState){
		var averageQuality = getAverageQuality(nextState);
		return Math.log(averageQuality + E);
	}

	function changeToShotInfo(shotsList){
		var cnt = 1;
		var length = shotsList.length;
		shotInfo[length - 1] = cnt;
		for(var i = 1;i < length ; i++){
			if(shotsList[length - 1 - i] == shotsList[length - 1]){
				cnt++;
			}else{
				cnt = 1;
			}
			shotInfo[length - 1 - i] = cnt;
		}

	}

	function changeToSaliencyInfo(saliencyList){

	}






	instance = {
		initialize:initialize,
		getNumStates:getNumStates,
		getMaxNumActions:getMaxNumActions,
		allowedActions:allowedActions,
		nextStateDistribution:nextStateDistribution,
		reward:reward

	};

	return instance;
}

DashEnvModel.__dashjs_factory_name = 'DashEnvModel';
export default FactoryMaker.getSingletonFactory(DashEnvModel);