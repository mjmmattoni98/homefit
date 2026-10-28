// Production entry point (`node server.js`).
//
// Wraps the adapter-node request handler so the public origin can be set at runtime through
// the ORIGIN environment variable. adapter-node 6 only accepts an origin at build time and
// otherwise assumes HTTPS, which breaks CSRF checks for plain-HTTP and pre-built deployments.
import http from 'node:http';
import process from 'node:process';

const PROTOCOL_HEADER = 'x-homefit-origin-protocol';
const HOST_HEADER = 'x-homefit-origin-host';

const origin = process.env.ORIGIN ? new URL(process.env.ORIGIN) : null;
if (origin !== null) {
	process.env.PROTOCOL_HEADER = PROTOCOL_HEADER;
	process.env.HOST_HEADER = HOST_HEADER;
}

const { handler } = await import('./build/handler.js');

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT ?? 30) * 1000;

const server = http.createServer((request, response) => {
	if (origin !== null) {
		request.headers[PROTOCOL_HEADER] = origin.protocol.slice(0, -1);
		request.headers[HOST_HEADER] = origin.host;
	}
	handler(request, response, () => {
		response.statusCode = 404;
		response.end('Not found');
	});
});

server.listen(port, host, () => {
	console.info(
		`HomeFit listening on http://${host}:${port}${origin ? ` (public origin ${origin.origin})` : ''}`
	);
});

let shuttingDown = false;

function shutdown(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	const forceClose = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
	server.close(() => {
		clearTimeout(forceClose);
		// Lets the app stop background jobs and close database pools (see src/hooks.server.ts).
		process.emit('sveltekit:shutdown', reason);
		setTimeout(() => process.exit(0), shutdownTimeoutMs).unref();
	});
	server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
