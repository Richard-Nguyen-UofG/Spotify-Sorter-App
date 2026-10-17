import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '2.5rem',
          margin: '2rem auto',
          maxWidth: '700px',
          background: 'rgba(231, 76, 60, 0.08)',
          border: '1px solid rgba(231, 76, 60, 0.4)',
          borderRadius: '16px',
          textAlign: 'center',
          color: '#fff'
        }}>
          <div style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'rgba(231, 76, 60, 0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1rem auto'
          }}>
            <AlertTriangle size={28} color="#ff6b6b" />
          </div>
          <h2 style={{ margin: '0 0 0.5rem 0', fontSize: '1.3rem' }}>Something Went Wrong</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.25rem', lineHeight: '1.45' }}>
            An unexpected error occurred during rendering. Your data is safe.
          </p>
          
          {this.state.error && (
            <div style={{
              background: 'rgba(0,0,0,0.4)',
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              color: '#ff857a',
              textAlign: 'left',
              overflowX: 'auto',
              marginBottom: '1.5rem',
              border: '1px solid rgba(255,255,255,0.06)'
            }}>
              {this.state.error.toString()}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button
              onClick={this.handleReset}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.6rem 1.25rem',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid var(--glass-border)',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <RefreshCw size={14} />
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '0.6rem 1.25rem',
                borderRadius: '8px',
                background: '#1DB954',
                border: 'none',
                color: '#000',
                fontSize: '0.85rem',
                fontWeight: 800,
                cursor: 'pointer'
              }}
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
