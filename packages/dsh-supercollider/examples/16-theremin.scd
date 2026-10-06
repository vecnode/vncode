// 16-theremin.scd -- a continuous, hand-moved lead line
//
// The technique: pitch slides instead of being selected, and there is no
// percussive transient at all. The absence of an attack is what makes this
// read as a bowed or sung instrument rather than a plucked one: a pluck is
// defined by the click of its onset, and here the envelope takes 300 ms to
// arrive, so the ear hears a note already in progress.
//
// `glide` is how far the pitch slides IN SEMITONES and how long it takes; the
// vibrato is always present, because a hand is never perfectly still.
//
// Play:
//   ~theremin.value(440)          // a little slide down onto A4
//   ~theremin.value(220, 0.3, 1, 12)  // a full octave slide, wide vibrato
//
// To play it live, hold the node and slide the pitch:
//   ~lead = Synth(\exTheremin, [\freq, 440, \glide, 7]); ~lead.set(\freq, 660);
(
SynthDef(\exTheremin, { |out = 0, freq = 440, amp = 0.25, gate = 1, vibrato = 0.3, glide = 0.3|
	var slideTime, base, vib, sig, env;
	// The slide: `glide` semitones above the target, falling onto it over a time
	// that grows with the interval. The pitch is read off `Line` in the exponent,
	// so the slide is even in PITCH rather than in Hz. At the default `glide` of
	// 0 the line is flat and the note simply starts where it is.
	slideTime = (glide.abs * 0.22).max(0.01);
	base = freq * (2 ** (Line.kr(glide, 0, slideTime) / 12));
	// An always-on vibrato around 5 Hz, a fraction of a semitone deep.
	vib = SinOsc.kr(5.1, 0, vibrato);
	sig = SinOsc.ar(base * (2 ** (vib / 12)));
	// Slow in, slow out: no transient to give away a mechanical onset.
	env = EnvGen.kr(Env.asr(0.35, 1, 1.1, \lin), gate, doneAction: 2);
	Out.ar(out, Pan2.ar(LeakDC.ar(sig * env * amp), 0));
}).add;
~theremin = { |hz = 440, level = 0.25, vib = 0.3, gl = 0.3|
	Synth(\exTheremin, [\freq, hz, \amp, level, \vibrato, vib, \glide, gl, \gate, 1]);
};
)
// ~theremin.value(440);
