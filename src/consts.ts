export const SITE_TITLE = 'DevOps Journey';
export const SITE_DESCRIPTION =
	'Docker, Network, Kubernetes, Cloud, Observability를 이해하고 실험한 내용을 정리하는 기술 블로그입니다.';

export const PROFILE_LINKS = {
	github: 'https://github.com/kimgunwooo',
	velog: 'https://velog.io/@kimgunwooo',
	email: 'mailto:kw4u1223@gmail.com',
};

export const BLOG_CATEGORIES = [
	{
		slug: 'docker',
		label: 'Docker',
		description: 'container, image, layer, BuildKit, registry cache를 바닥부터 정리합니다.',
	},
	{
		slug: 'network',
		label: 'Network',
		description: 'Docker network에서 Kubernetes service network로 이어지는 흐름을 정리합니다.',
	},
	{
		slug: 'kubernetes',
		label: 'Kubernetes',
		description: 'RKE2 홈 클러스터에서 배포, rollout, GitOps 문제를 작은 단위로 확인합니다.',
	},
	{
		slug: 'cloud',
		label: 'Cloud',
		description: 'AWS와 private cloud 관점에서 네트워크, 배포, 운영 구성을 정리합니다.',
	},
	{
		slug: 'observability',
		label: 'Observability',
		description: 'OpenTelemetry, log, metric, trace 수집 흐름과 유실 경계를 실험합니다.',
	},
	{
		slug: 'automation',
		label: 'Automation',
		description: 'Jenkins, Ansible, GitOps로 반복 작업을 줄일 때 필요한 기준을 기록합니다.',
	},
];
