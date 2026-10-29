// Production entry point (`bun server.js`).
//
// adapter-bun can only bake the public origin in at build time, and otherwise
// treats every request as HTTPS. ORIGIN is chosen when the process starts so the
// same image works for plain HTTP and for any host. Stamp it onto each request
// before the generated server reads PROTOCOL_HEADER and HOST_HEADER.

const origin = process.env.ORIGIN ? new URL(process.env.ORIGIN) : null;

if (origin !== null) {
	const protocolHeader = 'x-homefit-origin-protocol';
	const hostHeader = 'x-homefit-origin-host';
	process.env.PROTOCOL_HEADER = protocolHeader;
	process.env.HOST_HEADER = hostHeader;

	const protocol = origin.protocol.slice(0, -1);
	const host = origin.host;
	const serve = Bun.serve.bind(Bun);

	Bun.serve = (options) => {
		const fetch = options.fetch;
		if (typeof fetch === 'function') {
			options.fetch = (request, server) => {
				const headers = new Headers(request.headers);
				headers.set(protocolHeader, protocol);
				headers.set(hostHeader, host);
				return fetch(new Request(request, { headers }), server);
			};
		}
		return serve(options);
	};

	console.info(`HomeFit public origin ${origin.origin}`);
}

await import('./build/index.js');
