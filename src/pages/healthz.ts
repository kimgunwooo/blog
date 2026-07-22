export function GET() {
	return new Response(JSON.stringify({ ok: true, service: 'platform-ops-log' }), {
		headers: {
			'content-type': 'application/json',
		},
	});
}
