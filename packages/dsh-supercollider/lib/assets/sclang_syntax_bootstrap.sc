// Run: sclang bootstrap.sc /absolute/path/to/snippet.sc
// Compiles snippet only (no execution, no audio). Exit 0 = parse OK, 1 = syntax error.

(
var path = thisProcess.argv[0];
var code = File.open(path, "r").readAllString;
var f = thisProcess.interpreter.compile(code);
if (f.isNil) {
	1.exit;
} {
	0.exit;
};
)
