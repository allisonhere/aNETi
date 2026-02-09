import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          backgroundColor: '#070b1a',
          color: '#f8fafc',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>Something went wrong</h1>
        <p style={{ color: '#94a3b8', maxWidth: '32rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
          {this.state.error?.message ?? 'An unexpected error occurred.'}
        </p>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '0.375rem',
              border: '1px solid #334155',
              backgroundColor: '#1e293b',
              color: '#f8fafc',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Reset view
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '0.375rem',
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
