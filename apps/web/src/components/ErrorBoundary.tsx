/**
 * Last line of defence against a blank screen.
 *
 * A thrown error during render unmounts the whole React tree, and React leaves
 * an empty `#root` behind. To the person looking at it, that is the same class
 * of failure as an endless skeleton: the page "opened" and does nothing. The
 * difference is that this one is at least diagnosable, but only if the message
 * survives — the default behaviour is a console entry nobody reads.
 *
 * This boundary is scoped to the routed content, not the whole application, so a
 * crash inside one screen still leaves the sidebar and header usable: navigation
 * keeps working and the reader can leave the broken page.
 *
 * Note what it does *not* do: it never renders a fake success state, and it never
 * swallows the error. It shows the message and a way back.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icons } from './icons';

interface Props {
  children: ReactNode;
  /** Shown in the heading: what the crashed region was. */
  what: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept: the component stack is the only way to locate a render crash later.
    console.error(`[relay] ${this.props.what} crashed`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="p-5">
        <div className="surface rounded-xl p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/25">
              <Icons.AlertOctagon size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-mist-100">{this.props.what} failed to render.</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-mist-500">
                This is a defect in the interface, not a slow request. The rest of the
                application — navigation, search and every other screen — is unaffected.
              </p>
              <pre className="mt-2.5 overflow-x-auto rounded-lg border border-ink-600 bg-ink-900/80 p-2.5 font-mono text-[10.5px] leading-relaxed text-rose-200/90">
                {error.message}
              </pre>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={this.reset}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-750 px-2.5 py-1.5 text-[11.5px] font-medium text-mist-200 hover:border-gold-600/45 hover:text-white"
                >
                  <Icons.RotateCw size={12} /> Try again
                </button>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-750 px-2.5 py-1.5 text-[11.5px] font-medium text-mist-200 hover:border-gold-600/45 hover:text-white"
                >
                  <Icons.RefreshCw size={12} /> Reload the page
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
