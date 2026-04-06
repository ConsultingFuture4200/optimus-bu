"use client";

import {
  Component,
  createContext,
  useContext,
  useCallback,
  useState,
  type ReactNode,
  type ErrorInfo,
} from 'react';

// ---------------------------------------------------------------------------
// Async error context — allows hooks inside a plugin to trigger the boundary
// ---------------------------------------------------------------------------
const PluginErrorContext = createContext<((error: Error) => void) | null>(null);

export function usePluginError(): (error: Error) => void {
  const triggerError = useContext(PluginErrorContext);
  if (!triggerError) {
    throw new Error('usePluginError must be used within a PluginErrorBoundary');
  }
  return triggerError;
}

// ---------------------------------------------------------------------------
// Inner wrapper — holds async-triggered error state and throws to the class boundary
// ---------------------------------------------------------------------------
interface AsyncErrorWrapperProps {
  children: ReactNode;
}

function AsyncErrorWrapper({ children }: AsyncErrorWrapperProps) {
  const [asyncError, setAsyncError] = useState<Error | null>(null);

  const triggerError = useCallback((error: Error) => {
    setAsyncError(error);
  }, []);

  // Throw the async error so the outer class boundary catches it
  if (asyncError) {
    throw asyncError;
  }

  return (
    <PluginErrorContext.Provider value={triggerError}>
      {children}
    </PluginErrorContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Error boundary state
// ---------------------------------------------------------------------------
interface BoundaryState {
  hasError: boolean;
  error: Error | null;
  showDetails: boolean;
}

interface PluginErrorBoundaryProps {
  pluginName: string;
  children: ReactNode;
}

// ---------------------------------------------------------------------------
// PluginErrorBoundary — class component for render-time crash isolation
// Per D-18: catches render-time errors ONLY. No window.onerror or promise
// rejection handlers. Async errors are handled at the data layer (Phase 2).
// ---------------------------------------------------------------------------
export class PluginErrorBoundary extends Component<PluginErrorBoundaryProps, BoundaryState> {
  constructor(props: PluginErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      showDetails: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Structural logging per P3 — side effect of operating
    console.error('[PluginErrorBoundary] Caught render error:', {
      plugin: this.props.pluginName,
      error: error.message,
      componentStack: info.componentStack,
    });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null, showDetails: false });
  };

  private handleToggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  render() {
    const { hasError, error, showDetails } = this.state;
    const { pluginName, children } = this.props;

    if (hasError) {
      return (
        <div
          role="alert"
          className="flex flex-col gap-2 p-4 bg-neutral-900 border border-red-800/40 rounded-lg h-full"
        >
          <span className="text-sm font-semibold text-red-400">{pluginName}</span>
          <span className="text-sm text-neutral-400">Something went wrong</span>
          <button
            type="button"
            onClick={this.handleRetry}
            className="text-xs text-emerald-400 underline self-start"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={this.handleToggleDetails}
            className="text-xs text-neutral-500 self-start"
          >
            {showDetails ? 'Hide details' : 'Details'}
          </button>
          {showDetails && error && (
            <pre className="text-xs text-red-300 bg-neutral-950 p-2 rounded max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ''}
            </pre>
          )}
        </div>
      );
    }

    return (
      <AsyncErrorWrapper>
        {children}
      </AsyncErrorWrapper>
    );
  }
}

export default PluginErrorBoundary;
