<script lang="ts">
	import { page } from '$app/state';
	import GoalDayView from '#lib/components/goals/GoalDayView.svelte';
</script>

<GoalDayView day={page.params.day ?? null} />
