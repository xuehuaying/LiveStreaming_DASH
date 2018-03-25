import FactoryMaker from "../../../../src/core/FactoryMaker";
import Debug from '../../../../src/core/Debug';

function DPAgent(){
    /*
    V:state value function
    P:policy distribution  \pi(s,a)
    ns:number of states
    na:number of actions
    * */
    let V,
        P,
        ns,
        na,
    instance,
        env,
        gamma;
    let context = this.context;
    const log = Debug(context).getInstance().log;

    function initialize(config){
        env = config.env;
        gamma = getopt(config.opt,'gamma',0.75);
        ns = env.getNumStates();
        na = env.getMaxNumActions();
        V = zeros(ns);
        P = zeros(ns * na);
        //    initialize uniform random policy
        for(var s = 0; s < ns; s++){
            var poss = env.allowedActions(s);
            for(var i = 0, n = poss.length;i < n;i++){
                P[poss[i] * ns + s] = 1.0 / poss.length;
            }
        }
    }

    function act(s){
        // behave according to the learned policy
        var poss = env.allowedActions(s);
        var ps = [];
        for(var i=0,n=poss.length;i<n;i++) {
            var a = poss[i];
            var prob = P[a * ns+ s];
            ps.push(prob);
        }
        var maxi = sampleWeighted(ps);
        return poss[maxi];
    }
    function learn() {
        // perform a single round of value iteration
        this.evaluatePolicy(); // writes this.V
        this.updatePolicy(); // writes this.Ps
    }
    function evaluatePolicy() {
        // perform a synchronous update of the value function
        var Vnew = zeros(ns);
        for(var s = 0;s < ns;s++) {
            // integrate over actions in a stochastic policy
            // note that we assume that policy probability mass over allowed actions sums to one
            var v = 0.0;
            var poss = env.allowedActions(s);
            for(var i=0,n=poss.length;i<n;i++) {
                var a = poss[i];
                var prob = P[a*ns+s]; // probability of taking action under policy
                if(prob === 0) { continue; } // no contribution, skip for speed
                var nextState = env.nextStateDistribution(s,a);
                var rs = env.reward(s,a,nextState); // reward for s->a->ns transition
                v += prob * (rs + gamma * V[nextState]);
            }
            Vnew[s] = v;
        }
        V = Vnew; // swap
    }
    function updatePolicy() {
        // update policy to be greedy w.r.t. learned Value function
        for(var s=0;s<ns;s++) {
            var poss = env.allowedActions(s);
            // compute value of taking each allowed action
            var vmax, nmax;
            var vsum = 0;
            var vs = [];
            for(var i=0,n=poss.length;i<n;i++) {
                var a = poss[i];
                var nextState = env.nextStateDistribution(s,a);
                var rs = env.reward(s,a,nextState);
                var v = rs + gamma * V[nextState];
                vs.push(v);
                vsum += v;
                if(i === 0 || v > vmax) { vmax = v; nmax = 1; }
                else if(v === vmax) { nmax += 1; }
            }
            // update policy smoothly across all argmaxy actions
            for(var i=0,n=poss.length;i<n;i++) {
                var a = poss[i];
                P[a*ns+s] = (vs[i] === vmax) ? 1.0/nmax : 0.0;
                //P[a*ns+s] = vs[i]/vsum;
            }
        }
    }

    function getPolicy() {
        return P;

    }
    /*
    * helper functions
    * */
    // syntactic sugar function for getting default parameter values
    function getopt(opt, field_name, default_value) {
        if(typeof opt === 'undefined') { return default_value; }
        return (typeof opt[field_name] !== 'undefined') ? opt[field_name] : default_value;
    }
    // helper function returns array of zeros of length n
    // and uses typed arrays if available
    function zeros(n) {
        if(typeof(n)==='undefined' || isNaN(n)) { return []; }
        if(typeof ArrayBuffer === 'undefined') {
            // lacking browser support
            var arr = new Array(n);
            for(var i=0;i<n;i++) { arr[i] = 0; }
            return arr;
        } else {
            return new Float64Array(n);
        }
    }
    //Utility fun
    function assert(condition, message) {
        // from http://stackoverflow.com/questions/15313418/javascript-assert
        if (!condition) {
            message = message || "Assertion failed";
            if (typeof Error !== "undefined") {
                throw new Error(message);
            }
            throw message; // Fallback
        }
    }

    function randf(a, b) { return Math.random()*(b-a)+a; }
    function randi(a, b) { return Math.floor(Math.random()*(b-a)+a); }

    function sampleWeighted(p) {
        var r = Math.random();
        var c = 0.0;
        for(var i=0,n=p.length;i<n;i++) {
            c += p[i];
            if(c >= r) { return i; }
        }
        assert(false, 'wtf');
    }
    instance = {
        initialize:initialize,
        act:act,
        learn:learn,
        evaluatePolicy:evaluatePolicy,
        updatePolicy:updatePolicy,
        getPolicy:getPolicy

    };

    return instance;

}
DPAgent.__dashjs_factory_name = 'DPAgent';
export default FactoryMaker.getSingletonFactory(DPAgent);
//
// const factory = FactoryMaker.getClassFactory(DPAgent);
// export default factory;
