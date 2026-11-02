import { Component, ElementRef, Injectable, effect, inject, signal, viewChild } from '@angular/core';

interface Confirmation {
  title: string;
  message: string;
  action: string;
  resolve: (accepted: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmationService {
  readonly pending = signal<Confirmation | null>(null);

  confirm(title: string, message: string, action = 'Confirm'): Promise<boolean> {
    if (this.pending()) return Promise.resolve(false);
    return new Promise(resolve => this.pending.set({ title, message, action, resolve }));
  }

  finish(accepted: boolean): void {
    const request = this.pending();
    this.pending.set(null);
    request?.resolve(accepted);
  }
}

@Component({
  selector: 'app-confirmation',
  standalone: true,
  template: `
    <dialog #dialog class="app-dialog" aria-labelledby="confirmation-title"
      (cancel)="cancel($event)">
      @if (service.pending(); as request) {
        <h2 id="confirmation-title">{{ request.title }}</h2>
        <p>{{ request.message }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" autofocus (click)="finish(false)">Cancel</button>
          <button type="button" (click)="finish(true)">{{ request.action }}</button>
        </div>
      }
    </dialog>
  `,
})
export class ConfirmationDialog {
  readonly service = inject(ConfirmationService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  constructor() {
    effect(() => {
      const request = this.service.pending();
      const dialog = this.dialog().nativeElement;
      if (request && !dialog.open) dialog.showModal();
      else if (!request && dialog.open) dialog.close();
    });
  }
  finish(accepted: boolean): void { this.service.finish(accepted); }
  cancel(event: Event): void { event.preventDefault(); this.finish(false); }
}
