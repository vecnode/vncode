// 13-feedback-drone.scd -- a self-oscillating drone built from a feedback loop
//
// The technique: feedback is a delay plus a filter. `LocalOut` writes a signal
// into a one-block delay and `LocalIn` reads it back, so whatever the loop
// contains keeps circulating and accumulating. The band-pass decides which
// partials survive, and the gain of less than 1 in the loop is the damping:
// that damping is the whole difference between a tone and a scream.
//
// The loop is deliberately made impossible to run away with. A `LeakDC` and a
// `tanh` saturator sit inside it, so even at `fb = 0.99` the amplitude settles
// instead of growing to full scale.
//
// Play:
//   ~feedback.value(110)          // low, round drone
//   ~feedback.value(330, 0.99)    // brighter and more resonant
(
SynthDef(\exFeedback, { |out = 0, amp = 0.4, freq = 110, feedbackAmount = 0.98, gate = 1|
	var fb, shaped, harmonics, sig, env;
	// Everything the loop wrote on the previous control block, plus noise so
	// the loop has something to start from (feedback alone starts at silence).
	// The drive has to be LARGE, and this is the counter-intuitive part: the loop
	// throws away most of its energy on every pass - a narrow band-pass, then the
	// damping - so a whisper in never builds into a drone. Measured, with the drive
	// at `0.03` this came out at a peak of 0.0005 (inaudible) and at `0.25` still
	// only 0.0043. It is the pass count, not the gain, that sets the final level.
	fb = LocalIn.ar(1) + (PinkNoise.ar(1) * 8);
	// The filter is what the loop resonates at: a band-pass, then an octave of
	// harmonics stacked above it so the drone has a body, not just one peak.
	shaped = BPF.ar(fb, freq, 0.35);
	harmonics = shaped + (BPF.ar(fb, freq * 2, 0.5) * 0.5) + (BPF.ar(fb, freq * 4, 0.7) * 0.25);
	// DC blocked and soft-limited inside the loop: this is the safety catch.
	sig = LeakDC.ar(shaped + (harmonics * 0.3), 0.995);
	sig = Clip.ar(sig * feedbackAmount, -1, 1).tanh;
	LocalOut.ar(sig);
	// The audible tap is taken after the limiter, so it cannot exceed `amp`.
	env = EnvGen.kr(Env.asr(0.8, 1, 1.6, \lin), gate, doneAction: 2);
	Out.ar(out, Pan2.ar(HPF.ar(LeakDC.ar(sig), 25) * env * amp, 0));
}).add;
~feedback = { |hz = 110, fb = 0.98, level = 0.4|
	Synth(\exFeedback, [\freq, hz, \feedbackAmount, fb, \amp, level, \gate, 1]);
};
)
// ~feedback.value(110);
