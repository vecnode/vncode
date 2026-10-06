// argv[0] = absolute path to file containing user sclang code
// argv[1] = scsynth / supernova OSC UDP port (e.g. "57110")
// Connects with the running audio server and evaluates code (same as IDE sending to scsynth).
//
// Do not call .wait on this main thread: in headless sclang that deadlocks the scheduler
// (clock never advances), so the MCP client never gets a reply.

(
var codePath, port, code, addr, srv;
if (thisProcess.argv.size < 2) {
	"MCP_EXECUTE_ARGV: need user.sc path and UDP port".postln;
	2.exit;
};
codePath = thisProcess.argv[0];
port = thisProcess.argv[1].asInteger;
if (port <= 0) {
	("MCP_EXECUTE_BAD_PORT: " ++ thisProcess.argv[1]).postln;
	2.exit;
};
code = File.open(codePath, "r").readAllString;
addr = NetAddr("127.0.0.1", port);
srv = Server.remote(\mcpExec, addr, ServerOptions.new);

srv.latency = 0.05;
Server.default = srv;

try {
	code.interpret;
} { |err|
	err.errorString.postln;
	1.exit;
};

"MCP_EXECUTE_OK".postln;
0.exit;
)
