// 11-additive-organ.scd -- a drawbar organ, held while the gate is open
//
// The technique: additive harmonic synthesis. A Hammond does not filter a
// buzzy waveform, it builds the tone by summing sine partials on the nine
// drawbars, and each drawbar level is one partial's amplitude. Here the
// partials are 1, 2, 3, 4, 6 and 8 times `freq` and `brightness` tilts the
// upper ones, which is the same gesture as pulling the top drawbars out.
//
// The "key click" is a very short noise burst at the attack. Hold the note
// with `gate: 1` and release it with `gate: 0`; the envelope frees the node.
//
// Play:
//   ~organ.value(220)          // A3, medium registration
//   ~organ.value(110, 0.2, 1.8) // low and bright, clickier
(
SynthDef(\exOrgan, { |out = 0, freq = 220, amp = 0.25, gate = 1, brightness = 1|
	var ratios, levels, tilt, tiltSum, tone, detune, chorus, click, env, sig;
	// Drawbar lengths: octave, octave + fifth, octave + third, two octaves.
	ratios = #[1, 2, 3, 4, 6, 8];
	// Drawbar registrations, from a full-bodied 16' through to a bright 1'.
	levels = #[1, 0.62, 0.44, 0.30, 0.20, 0.14];
	// `brightness` lifts every partial above the fundamental.
	tilt = levels.collect { |l, i| l * (brightness ** i) };
	tiltSum = tilt.sum;
	tone = ratios.collect { |r, i| SinOsc.ar(freq * r) * (tilt[i] / tiltSum) }.sum;
	// Chorus: two slightly detuned copies, as a real organ's scanner does.
	// `SinOsc.ar` with an array of frequencies broadcasts into two channels.
	detune = freq * 0.0055;
	chorus = SinOsc.ar([freq - detune, freq + detune]).mean;
	// Key click: 8 ms of noise, gone long before the tone is established.
	click = HPF.ar(WhiteNoise.ar(1), 2000) * EnvGen.kr(Env.perc(0.0005, 0.008));
	env = EnvGen.kr(Env.asr(0.006, 1, 0.09, \lin), gate, doneAction: 2);
	sig = ((tone * 0.8) + (chorus * 0.25) + (click * 0.05)) * env * amp;
	Out.ar(out, Pan2.ar(LeakDC.ar(sig), 0));
}).add;
~organ = { |hz = 220, level = 0.25, bright = 1|
	Synth(\exOrgan, [\freq, hz, \amp, level, \brightness, bright, \gate, 1]);
};
)
// ~organ.value(220);
