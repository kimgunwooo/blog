export function GET() {
	return new Response(JSON.stringify({ ok: true, service: 'blog' }), {
		headers: {
			'content-type': 'application/json',
		},
	});
}
