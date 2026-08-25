import { Fragment, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSuppressToastsWhileOpen } from './ToastProvider';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'full';
  /** When false, clicking the backdrop does NOT close the modal. Use for modals
   *  where an accidental outside tap is costly — e.g. a signature pad where a
   *  stray touch near the edge would otherwise discard the drawing. */
  closeOnBackdrop?: boolean;
}

export default function Modal({ isOpen, onClose, title, children, size = 'md', closeOnBackdrop = true }: ModalProps) {
  useSuppressToastsWhileOpen(isOpen);
  if (!isOpen) return null;

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    full: 'max-w-full mx-4',
  };

  const modalContent = (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="flex min-h-full items-end sm:items-center justify-center p-4">
        <div
          className={`relative w-full ${sizes[size]} bg-white rounded-2xl shadow-2xl transform transition-all border border-gray-100 ring-1 ring-black/5`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          {title && (
            <div className="flex items-center justify-between p-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
              <button
                onClick={onClose}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
                aria-label="Close modal"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Content */}
          <div className="p-4">
            {children}
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof window === 'undefined') return null;

  return createPortal(modalContent, document.body);
}
