import { Show } from 'solid-js';
import { meterLevel, meterTooltip, type ContextUsage } from './contextMeter';

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A small ring in the composer toolbar showing how full the chat's context window is. Hidden until a reply reports usage. */
export function ContextMeter(props: { usage: ContextUsage | undefined; threshold: number }) {
	return (
		<Show when={props.usage}>
			{usage => {
				const percent = () => usage().percent;
				const tooltip = () => meterTooltip(usage(), props.threshold);
				return (
					<span
						class={`lens-context-meter ${meterLevel(percent())}`}
						role="img"
						aria-label={tooltip()}
						title={tooltip()}
						data-percent={percent() ?? ''}
						data-tokens={usage().tokens}
					>
						<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
							<circle class="lens-context-meter-track" cx="8" cy="8" r={RADIUS} fill="none" stroke-width="2" />
							<circle
								class="lens-context-meter-fill"
								cx="8"
								cy="8"
								r={RADIUS}
								fill="none"
								stroke-width="2"
								stroke-dasharray={`${CIRCUMFERENCE * (percent() ?? 0) / 100} ${CIRCUMFERENCE}`}
								transform="rotate(-90 8 8)"
							/>
						</svg>
						<Show when={percent() !== undefined}>
							<span class="lens-context-meter-label">{percent()}%</span>
						</Show>
					</span>
				);
			}}
		</Show>
	);
}
