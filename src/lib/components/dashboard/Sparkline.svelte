<script lang="ts">
	let {
		values,
		kind = 'line',
		color
	}: {
		/** Oldest first; null where there is no value. */
		values: (number | null)[];
		kind?: 'line' | 'bars';
		color: string;
	} = $props();

	const WIDTH = 100;
	const HEIGHT = 28;

	const scale = $derived.by(() => {
		const present = values.filter((value): value is number => value !== null);
		const min = kind === 'bars' ? 0 : Math.min(...present);
		const max = Math.max(...present);
		return { min, span: max - min || 1, empty: present.length === 0 };
	});

	const x = (index: number) =>
		values.length < 2 ? WIDTH / 2 : (index / (values.length - 1)) * WIDTH;
	const y = (value: number) => HEIGHT - 2 - ((value - scale.min) / scale.span) * (HEIGHT - 4);

	const path = $derived(
		values
			.flatMap((value, index) => (value === null ? [] : [`${x(index)},${y(value)}`]))
			.map((point, index) => `${index === 0 ? 'M' : 'L'}${point}`)
			.join(' ')
	);
	const barWidth = $derived(Math.max(0.6, (WIDTH / Math.max(1, values.length)) * 0.65));
</script>

<!-- Stretched to the cell's width; the stroke keeps its thickness. -->
<svg
	viewBox="0 0 {WIDTH} {HEIGHT}"
	preserveAspectRatio="none"
	class="h-7 w-full overflow-visible"
	aria-hidden="true"
>
	{#if !scale.empty}
		{#if kind === 'line'}
			<path
				d={path}
				fill="none"
				stroke={color}
				stroke-width="1.5"
				stroke-linejoin="round"
				vector-effect="non-scaling-stroke"
			/>
		{:else}
			{#each values as value, index (index)}
				{#if value}
					<rect
						x={(index + 0.5) * (WIDTH / values.length) - barWidth / 2}
						y={y(value)}
						width={barWidth}
						height={HEIGHT - 2 - y(value)}
						fill={color}
						opacity="0.8"
					/>
				{/if}
			{/each}
		{/if}
	{/if}
</svg>
