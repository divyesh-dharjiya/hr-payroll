import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Theme } from './core/theme';

/** Root component. Layout and navigation live in the Shell route; public pages render directly here. */
@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {
  // Created eagerly so the saved light/dark theme applies before any page renders.
  private readonly theme = inject(Theme);
}
