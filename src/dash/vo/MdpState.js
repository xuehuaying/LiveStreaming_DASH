/**
 * Created by Aimmee Xue on 2018/3/1.
 */
/**
 * @class
 * @ignore
 */
class MdpState {
	constructor() {
		this.buffer = null;
		this.bandwidth = null;
		this.bitrateVector= [];
		this.p = 0;
		this.s = Number.POSITIVE_INFINITY;
	}
}

export default MdpState;