<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { useSidebar } from '#lib/components/ui/sidebar/index.js';

	// On small screens the sidebar is a sheet over the page; close it once a link is followed.
	const sidebar = useSidebar();
	afterNavigate(() => sidebar.setOpenMobile(false));
</script>
