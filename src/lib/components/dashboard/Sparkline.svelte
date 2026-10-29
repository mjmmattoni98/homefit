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

	// Drawn at the cell's measured width, so bars keep square ends and the latest point stays round.
	const HEIGHT = 32;
	const INSET = 3;
	const MAX_BAR = 6;

	let width = $state(0);

	const present = $derived(values.filter((value): value is number => value !== null));
	const latest = $derived(values.findLastIndex((value) => value !== null));
	const scale = $derived.by(() => {
		const min = kind === 'bars' ? 0 : Math.min(...present);
		const max = Math.max(...present);
		return { min, span: max - min || 1 };
	});

	const plotWidth = $derived(Math.max(0, width - INSET * 2));
	const x = (index: number) =>
		INSET + (values.length < 2 ? plotWidth / 2 : (index / (values.length - 1)) * plotWidth);
	const y = (value: number) =>
		HEIGHT - INSET - ((value - scale.min) / scale.span) * (HEIGHT - INSET * 2);

	const path = $derived(
		values
			.flatMap((value, index) => (value === null ? [] : [`${x(index)},${y(value)}`]))
			.map((point, index) => `${index === 0 ? 'M' : 'L'}${point}`)
			.join(' ')
	);
	const slot = $derived(width / Math.max(1, values.length));
	const barWidth = $derived(Math.max(1, Math.min(MAX_BAR, slot * 0.6)));
</script>

<div class="h-8 w-full" bind:clientWidth={width} aria-hidden="true">
	{#if width > 0 && present.length > 0}
		<svg {width} height={HEIGHT} class="block overflow-visible">
			{#if kind === 'line'}
				<path
					d={path}
					fill="none"
					style:stroke={color}
					stroke-width="1.5"
					stroke-linejoin="round"
					stroke-linecap="round"
				/>
				{#if latest >= 0}
					<circle cx={x(latest)} cy={y(values[latest] ?? 0)} r="2.5" style:fill={color} />
				{/if}
			{:else}
				<!-- The zero line, in the series' own colour so it reads on the day and on the night. -->
				<line
					x1={0}
					x2={width}
					y1={HEIGHT - INSET}
					y2={HEIGHT - INSET}
					style:stroke={color}
					stroke-opacity="0.35"
				/>
				{#each values as value, index (index)}
					{#if value}
						<rect
							x={(index + 0.5) * slot - barWidth / 2}
							y={y(value)}
							width={barWidth}
							height={HEIGHT - INSET - y(value)}
							style:fill={color}
							opacity={index === latest ? 1 : 0.5}
						/>
					{/if}
				{/each}
			{/if}
		</svg>
	{/if}
</div>
