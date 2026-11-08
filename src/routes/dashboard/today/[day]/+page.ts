import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageLoad = ({ params }) => {
	if (!DAY.test(params.day)) error(404, 'Not found');
	return {};
};
