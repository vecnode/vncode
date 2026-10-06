// 08-pad-drone.scd -- a detuned saw drone under a moving filter
//
// The technique: three sawtooth oscillators at the same nominal pitch, each a
// fraction of a Hz away from the next. They cannot stay in phase, so their sum
// swells and fades as they drift - that slow beating is a chorus made out of
// nothing but detuning, where a chorus effect would have faked the same thing
// with a delay line. Beat rate = the detune in Hz, so 0.6 beats once in 1.7 s.
//
// The filter is where the movement is. A resonant low-pass sits at `cutoff` and
// a very slow LFO rides it up and down: without the LFO a static filter on a
// static drone is a still photograph, and with it the same two numbers breathe.
//
// `gate` holds the voice. It is 1 by default, so the Synth sustains until you
// release it - `Env.asr` fades it out over 2.5 s and then frees the node.
//
// Play:
//   ~p = ~pad.value(55, 0.2)    // start the drone; keep the Synth
//   ~p.set(\cutoff, 2200)       // open the filter while it sounds
//   ~p.set(\gate, 0)            // release it; it frees itself
(
SynthDef(\exPad, { |out = 0, freq = 55, amp = 0.2, gate = 1, cutoff = 900, rq = 0.4, detune = 0.6, pan = 0|
	var env, saws, lfo, sig;
	env = EnvGen.kr(Env.asr(0.8, 1, 2.5, -4), gate, doneAction: 2);
	// detune is in Hz. Phase is not reset, so the three never line up twice.
	saws = Saw.ar([freq, freq + detune, freq - detune]);
	// 0.05 Hz: a full sweep of the cutoff takes 20 s, which is slow enough to
	// hear as movement rather than as vibrato.
	lfo = SinOsc.kr(0.05, 0, cutoff * 0.4, cutoff * 1.1);
	sig = RLPF.ar(saws, lfo, rq);
	// Three saws can align; 0.5 leaves the resonant filter the rest of the head-
	// room, and LeakDC keeps the sub-audio drift out of the output.
	sig = LeakDC.ar(sig.sum * 0.5);
	Out.ar(out, Pan2.ar(sig * env * amp, pan));
}).add;
~pad = { |hz = 55, level = 0.2, cut = 900| Synth(\exPad, [\freq, hz, \amp, level, \cutoff, cut]) };
)
// ~p = ~pad.value(55, 0.2);
// ~p.set(\gate, 0);
