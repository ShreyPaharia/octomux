import { toast as sonnerToast } from 'sonner';
import { X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

const ACCENT_COLORS: Record<ToastType, string> = {
  success: '#22C55E',
  error: '#EF4444',
  warning: '#FFB800',
  info: '#3B82F6',
};

interface CustomToastProps {
  id: string | number;
  type: ToastType;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

export function CustomToast({ id, type, title, description, action }: CustomToastProps) {
  return (
    <div
      style={{
        width: 360,
        background: '#0A0A0A',
        border: '1px solid #2f2f2f',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontFamily: "'JetBrains Mono Variable', monospace",
      }}
    >
      {/* Accent bar */}
      <div
        style={{
          width: 3,
          height: 32,
          flexShrink: 0,
          backgroundColor: ACCENT_COLORS[type],
          borderRadius: 0,
        }}
      />

      {/* Text content */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: '#FFFFFF',
            textTransform: 'uppercase',
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 400,
            color: '#8a8a8a',
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {description}
        </div>
      </div>

      {/* Action button */}
      {action && (
        <button
          onClick={() => {
            action.onClick();
            sonnerToast.dismiss(id);
          }}
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontWeight: 700,
            color: ACCENT_COLORS[type],
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px 8px',
            fontFamily: "'JetBrains Mono Variable', monospace",
            textTransform: 'uppercase',
          }}
        >
          {action.label}
        </button>
      )}

      {/* Close button */}
      <button
        onClick={() => sonnerToast.dismiss(id)}
        style={{
          flexShrink: 0,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={12} color="#6a6a6a" />
      </button>
    </div>
  );
}

/** Helper to fire a styled custom toast. */
export function showToast(
  type: ToastType,
  title: string,
  description: string,
  action?: { label: string; onClick: () => void },
) {
  return sonnerToast.custom((id) => (
    <CustomToast id={id} type={type} title={title} description={description} action={action} />
  ));
}
