<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	export const toggleVariants = tv({
		base: "text-ink-2 hover:text-foreground aria-pressed:bg-muted focus-visible:ring-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[state=on]:bg-muted data-[state=on]:text-foreground gap-1 rounded-md text-sm font-medium transition-[color,background-color,box-shadow] duration-(--dur-micro) ease-out [&_svg:not([class*='size-'])]:size-4 group/toggle hover:bg-muted inline-flex items-center justify-center whitespace-nowrap outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				default: 'bg-transparent',
				// A tab on the horizon: the chosen one is underlined in sun.
				outline:
					'rounded-none text-ink-3 hover:bg-transparent hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:text-foreground data-[state=on]:shadow-[inset_0_-2px_0_var(--color-sun)]'
			},
			size: {
				default:
					'h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				sm: "h-7 min-w-7 px-2 text-[0.8125rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				lg: 'h-9 min-w-9 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ToggleVariant = VariantProps<typeof toggleVariants>['variant'];
	export type ToggleSize = VariantProps<typeof toggleVariants>['size'];
	export type ToggleVariants = VariantProps<typeof toggleVariants>;
</script>

<script lang="ts">
	import { Toggle as TogglePrimitive } from 'bits-ui';
	import { cn } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		pressed = $bindable(false),
		class: className,
		size = 'default',
		variant = 'default',
		...restProps
	}: TogglePrimitive.RootProps & {
		variant?: ToggleVariant;
		size?: ToggleSize;
	} = $props();
</script>

<TogglePrimitive.Root
	bind:ref
	bind:pressed
	data-slot="toggle"
	class={cn(toggleVariants({ variant, size }), className)}
	{...restProps}
/>
