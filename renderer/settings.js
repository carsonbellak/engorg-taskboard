// Settings Page - theme selection, app configuration

const COLOR_THEMES = {
  default: {
    name: 'Default',
    desc: 'Clean and professional',
    style: 'standard',
    vars: {
      '--bg-primary': '#FFFFFF',
      '--bg-secondary': '#F8FAFC',
      '--bg-sidebar': '#FFFFFF',
      '--bg-header': '#FFFFFF',
      '--bg-card': '#FFFFFF',
      '--bg-input': '#FFFFFF',
      '--bg-hover': '#F1F5F9',
      '--border-color': '#E2E8F0',
      '--border-light': '#F1F5F9',
      '--text-primary': '#0F172A',
      '--text-secondary': '#334155',
      '--text-muted': '#64748B',
      '--text-faint': '#94A3B8',
      '--accent': '#3B82F6',
      '--accent-hover': '#2563EB',
      '--accent-bg': '#EFF6FF',
      '--accent-text': '#2563EB',
      '--success': '#22C55E',
      '--warning': '#F59E0B',
      '--danger': '#EF4444',
      '--shadow': 'rgba(0,0,0,0.08)',
      '--shadow-lg': 'rgba(0,0,0,0.12)',
      '--radius-sm': '8px',
      '--radius-md': '10px',
      '--radius-lg': '12px',
      '--border-width': '1px',
      '--card-border-width': '1.5px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '1px solid var(--border-color)',
      '--sidebar-border': '1px solid var(--border-color)',
      '--card-shadow': '0 2px 8px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)',
      '--card-hover-shadow': '0 12px 28px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.08)',
      '--btn-shadow': '0 2px 8px rgba(59,130,246,0.3)',
    }
  },
  dark: {
    name: 'Dark',
    desc: 'Easy on the eyes',
    style: 'dark',
    vars: {
      '--bg-primary': '#0F172A',
      '--bg-secondary': '#1E293B',
      '--bg-sidebar': '#1E293B',
      '--bg-header': '#0F172A',
      '--bg-card': '#1E293B',
      '--bg-input': '#0F172A',
      '--bg-hover': '#334155',
      '--border-color': '#334155',
      '--border-light': '#1E293B',
      '--text-primary': '#F1F5F9',
      '--text-secondary': '#CBD5E1',
      '--text-muted': '#94A3B8',
      '--text-faint': '#64748B',
      '--accent': '#3B82F6',
      '--accent-hover': '#60A5FA',
      '--accent-bg': 'rgba(59,130,246,0.15)',
      '--accent-text': '#60A5FA',
      '--success': '#4ADE80',
      '--warning': '#FBBF24',
      '--danger': '#F87171',
      '--shadow': 'rgba(0,0,0,0.3)',
      '--shadow-lg': 'rgba(0,0,0,0.5)',
      '--radius-sm': '8px',
      '--radius-md': '10px',
      '--radius-lg': '12px',
      '--border-width': '1px',
      '--card-border-width': '1.5px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '1px solid var(--border-color)',
      '--sidebar-border': '1px solid var(--border-color)',
      '--card-shadow': '0 2px 8px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)',
      '--card-hover-shadow': '0 12px 28px rgba(0,0,0,0.4), 0 4px 8px rgba(0,0,0,0.3)',
      '--btn-shadow': '0 2px 8px rgba(59,130,246,0.4)',
      '--scrollbar-thumb': 'rgba(148,163,184,0.3)',
      '--scrollbar-thumb-hover': 'rgba(148,163,184,0.5)',
    }
  },
  glass: {
    name: 'Glass',
    desc: 'Frosted translucent panels',
    style: 'glass',
    vars: {
      '--bg-primary': '#0B0E1A',
      '--bg-secondary': 'rgba(20,25,50,0.6)',
      '--bg-sidebar': 'rgba(15,20,40,0.5)',
      '--bg-header': 'rgba(15,20,40,0.7)',
      '--bg-card': 'rgba(255,255,255,0.06)',
      '--bg-input': 'rgba(255,255,255,0.05)',
      '--bg-hover': 'rgba(255,255,255,0.08)',
      '--border-color': 'rgba(255,255,255,0.1)',
      '--border-light': 'rgba(255,255,255,0.05)',
      '--text-primary': '#E8ECF4',
      '--text-secondary': '#B8C4D8',
      '--text-muted': '#7B8BA8',
      '--text-faint': '#4F5F7A',
      '--accent': '#818CF8',
      '--accent-hover': '#A5B4FC',
      '--accent-bg': 'rgba(129,140,248,0.12)',
      '--accent-text': '#A5B4FC',
      '--success': '#34D399',
      '--warning': '#FBBF24',
      '--danger': '#FB7185',
      '--shadow': 'rgba(0,0,0,0.2)',
      '--shadow-lg': 'rgba(0,0,0,0.4)',
      '--radius-sm': '12px',
      '--radius-md': '16px',
      '--radius-lg': '20px',
      '--border-width': '1px',
      '--card-border-width': '1px',
      '--header-bg': 'rgba(15,20,40,0.7)',
      '--sidebar-bg': 'rgba(15,20,40,0.5)',
      '--card-blur': '20px',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '600',
      '--font-weight-heavy': '700',
      '--header-border': '1px solid rgba(255,255,255,0.08)',
      '--sidebar-border': '1px solid rgba(255,255,255,0.06)',
      '--card-shadow': '0 4px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06)',
      '--card-hover-shadow': '0 16px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)',
      '--btn-shadow': '0 4px 16px rgba(129,140,248,0.3)',
    }
  },
  neon: {
    name: 'Neon',
    desc: 'Cyberpunk glow effects',
    style: 'neon',
    vars: {
      '--bg-primary': '#0A0A0F',
      '--bg-secondary': '#111118',
      '--bg-sidebar': '#0D0D14',
      '--bg-header': '#0A0A0F',
      '--bg-card': '#141420',
      '--bg-input': '#0E0E16',
      '--bg-hover': '#1A1A2A',
      '--border-color': '#2A2A3E',
      '--border-light': '#1A1A28',
      '--text-primary': '#E0E0FF',
      '--text-secondary': '#A0A0CC',
      '--text-muted': '#6B6B99',
      '--text-faint': '#44446B',
      '--accent': '#00FFAA',
      '--accent-hover': '#33FFBb',
      '--accent-bg': 'rgba(0,255,170,0.08)',
      '--accent-text': '#00FFAA',
      '--success': '#00FF88',
      '--warning': '#FFD600',
      '--danger': '#FF2266',
      '--shadow': 'rgba(0,255,170,0.05)',
      '--shadow-lg': 'rgba(0,255,170,0.1)',
      '--radius-sm': '4px',
      '--radius-md': '6px',
      '--radius-lg': '8px',
      '--border-width': '1px',
      '--card-border-width': '1px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '600',
      '--font-weight-heavy': '800',
      '--header-border': '1px solid #2A2A3E',
      '--sidebar-border': '1px solid #2A2A3E',
      '--card-shadow': '0 0 12px rgba(0,255,170,0.06), 0 2px 8px rgba(0,0,0,0.4)',
      '--card-hover-shadow': '0 0 24px rgba(0,255,170,0.15), 0 8px 24px rgba(0,0,0,0.5)',
      '--btn-shadow': '0 0 20px rgba(0,255,170,0.3), 0 0 40px rgba(0,255,170,0.1)',
    }
  },
  brutalist: {
    name: 'Brutalist',
    desc: 'Bold borders, raw edges',
    style: 'brutalist',
    vars: {
      '--bg-primary': '#FFFFF0',
      '--bg-secondary': '#FAFAE0',
      '--bg-sidebar': '#FFFFF0',
      '--bg-header': '#000000',
      '--bg-card': '#FFFFF0',
      '--bg-input': '#FFFFF0',
      '--bg-hover': '#F0F0D8',
      '--border-color': '#000000',
      '--border-light': '#CCCCAA',
      '--text-primary': '#000000',
      '--text-secondary': '#222200',
      '--text-muted': '#555544',
      '--text-faint': '#888870',
      '--accent': '#FF3300',
      '--accent-hover': '#CC2900',
      '--accent-bg': '#FFEEEE',
      '--accent-text': '#CC0000',
      '--success': '#008800',
      '--warning': '#CC8800',
      '--danger': '#CC0000',
      '--shadow': 'rgba(0,0,0,0)',
      '--shadow-lg': 'rgba(0,0,0,0)',
      '--radius-sm': '0px',
      '--radius-md': '0px',
      '--radius-lg': '0px',
      '--border-width': '3px',
      '--card-border-width': '3px',
      '--header-bg': '#000000',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '500',
      '--font-weight-bold': '800',
      '--font-weight-heavy': '900',
      '--header-border': '3px solid #000000',
      '--sidebar-border': '3px solid #000000',
      '--card-shadow': '4px 4px 0px #000000',
      '--card-hover-shadow': '6px 6px 0px #000000',
      '--btn-shadow': '3px 3px 0px #000000',
    }
  },
  nord: {
    name: 'Nord',
    desc: 'Arctic cool palette',
    style: 'nord',
    vars: {
      '--bg-primary': '#2E3440',
      '--bg-secondary': '#3B4252',
      '--bg-sidebar': '#2E3440',
      '--bg-header': '#2E3440',
      '--bg-card': '#3B4252',
      '--bg-input': '#2E3440',
      '--bg-hover': '#434C5E',
      '--border-color': '#434C5E',
      '--border-light': '#3B4252',
      '--text-primary': '#ECEFF4',
      '--text-secondary': '#D8DEE9',
      '--text-muted': '#81A1C1',
      '--text-faint': '#5E81AC',
      '--accent': '#88C0D0',
      '--accent-hover': '#8FBCBB',
      '--accent-bg': 'rgba(136,192,208,0.12)',
      '--accent-text': '#88C0D0',
      '--success': '#A3BE8C',
      '--warning': '#EBCB8B',
      '--danger': '#BF616A',
      '--shadow': 'rgba(0,0,0,0.2)',
      '--shadow-lg': 'rgba(0,0,0,0.4)',
      '--radius-sm': '6px',
      '--radius-md': '8px',
      '--radius-lg': '10px',
      '--border-width': '1px',
      '--card-border-width': '1px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '600',
      '--font-weight-heavy': '700',
      '--header-border': '1px solid #434C5E',
      '--sidebar-border': '1px solid #434C5E',
      '--card-shadow': '0 2px 8px rgba(0,0,0,0.2)',
      '--card-hover-shadow': '0 8px 24px rgba(0,0,0,0.3)',
      '--btn-shadow': '0 2px 8px rgba(136,192,208,0.3)',
    }
  },
  midnight: {
    name: 'Midnight',
    desc: 'Deep purple dark theme',
    style: 'midnight',
    vars: {
      '--bg-primary': '#13111C',
      '--bg-secondary': '#1C1929',
      '--bg-sidebar': '#1C1929',
      '--bg-header': '#13111C',
      '--bg-card': '#1C1929',
      '--bg-input': '#13111C',
      '--bg-hover': '#2D2640',
      '--border-color': '#2D2640',
      '--border-light': '#1C1929',
      '--text-primary': '#E8E4F0',
      '--text-secondary': '#C4BDD4',
      '--text-muted': '#8B80A5',
      '--text-faint': '#6B5F85',
      '--accent': '#A78BFA',
      '--accent-hover': '#C4B5FD',
      '--accent-bg': 'rgba(167,139,250,0.15)',
      '--accent-text': '#C4B5FD',
      '--success': '#4ADE80',
      '--warning': '#FBBF24',
      '--danger': '#F87171',
      '--shadow': 'rgba(0,0,0,0.4)',
      '--shadow-lg': 'rgba(0,0,0,0.6)',
      '--radius-sm': '8px',
      '--radius-md': '10px',
      '--radius-lg': '12px',
      '--border-width': '1px',
      '--card-border-width': '1.5px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '1px solid var(--border-color)',
      '--sidebar-border': '1px solid var(--border-color)',
      '--card-shadow': '0 2px 8px rgba(0,0,0,0.3)',
      '--card-hover-shadow': '0 12px 28px rgba(0,0,0,0.4)',
      '--btn-shadow': '0 2px 8px rgba(167,139,250,0.3)',
    }
  },
  forest: {
    name: 'Forest',
    desc: 'Earthy greens',
    style: 'forest',
    vars: {
      '--bg-primary': '#F0F7F4',
      '--bg-secondary': '#E6F0EB',
      '--bg-sidebar': '#E6F0EB',
      '--bg-header': '#F0F7F4',
      '--bg-card': '#FFFFFF',
      '--bg-input': '#FFFFFF',
      '--bg-hover': '#D5E8DD',
      '--border-color': '#C6DDD0',
      '--border-light': '#E6F0EB',
      '--text-primary': '#1A3A2A',
      '--text-secondary': '#2D5940',
      '--text-muted': '#4A7A5C',
      '--text-faint': '#7BA68C',
      '--accent': '#16A34A',
      '--accent-hover': '#15803D',
      '--accent-bg': '#DCFCE7',
      '--accent-text': '#15803D',
      '--success': '#22C55E',
      '--warning': '#F59E0B',
      '--danger': '#EF4444',
      '--shadow': 'rgba(26,58,42,0.08)',
      '--shadow-lg': 'rgba(26,58,42,0.15)',
      '--radius-sm': '8px',
      '--radius-md': '10px',
      '--radius-lg': '12px',
      '--border-width': '1px',
      '--card-border-width': '1.5px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '1px solid var(--border-color)',
      '--sidebar-border': '1px solid var(--border-color)',
      '--card-shadow': '0 2px 8px rgba(26,58,42,0.08), 0 1px 2px rgba(26,58,42,0.06)',
      '--card-hover-shadow': '0 12px 28px rgba(26,58,42,0.15), 0 4px 8px rgba(26,58,42,0.1)',
      '--btn-shadow': '0 2px 8px rgba(22,163,74,0.3)',
    }
  },
  ocean: {
    name: 'Ocean',
    desc: 'Deep blue calm',
    style: 'ocean',
    vars: {
      '--bg-primary': '#0C1222',
      '--bg-secondary': '#131D33',
      '--bg-sidebar': '#131D33',
      '--bg-header': '#0C1222',
      '--bg-card': '#131D33',
      '--bg-input': '#0C1222',
      '--bg-hover': '#1A2844',
      '--border-color': '#1E3055',
      '--border-light': '#131D33',
      '--text-primary': '#E0E8F5',
      '--text-secondary': '#B0C4E0',
      '--text-muted': '#6B8DBB',
      '--text-faint': '#4A6A8F',
      '--accent': '#0EA5E9',
      '--accent-hover': '#38BDF8',
      '--accent-bg': 'rgba(14,165,233,0.15)',
      '--accent-text': '#38BDF8',
      '--success': '#34D399',
      '--warning': '#FBBF24',
      '--danger': '#FB7185',
      '--shadow': 'rgba(0,0,0,0.4)',
      '--shadow-lg': 'rgba(0,0,0,0.6)',
      '--radius-sm': '8px',
      '--radius-md': '10px',
      '--radius-lg': '12px',
      '--border-width': '1px',
      '--card-border-width': '1.5px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '1px solid var(--border-color)',
      '--sidebar-border': '1px solid var(--border-color)',
      '--card-shadow': '0 2px 8px rgba(0,0,0,0.3)',
      '--card-hover-shadow': '0 12px 28px rgba(0,0,0,0.4)',
      '--btn-shadow': '0 2px 8px rgba(14,165,233,0.3)',
    }
  },
  rose: {
    name: 'Rose',
    desc: 'Warm pink tones',
    style: 'rose',
    vars: {
      '--bg-primary': '#FFF5F7',
      '--bg-secondary': '#FEE2E8',
      '--bg-sidebar': '#FEE2E8',
      '--bg-header': '#FFF5F7',
      '--bg-card': '#FFFFFF',
      '--bg-input': '#FFFFFF',
      '--bg-hover': '#FECDD3',
      '--border-color': '#FECDD3',
      '--border-light': '#FEE2E8',
      '--text-primary': '#4C0519',
      '--text-secondary': '#881337',
      '--text-muted': '#BE185D',
      '--text-faint': '#F472B6',
      '--accent': '#E11D48',
      '--accent-hover': '#BE123C',
      '--accent-bg': '#FFE4E6',
      '--accent-text': '#BE123C',
      '--success': '#22C55E',
      '--warning': '#F59E0B',
      '--danger': '#EF4444',
      '--shadow': 'rgba(76,5,25,0.08)',
      '--shadow-lg': 'rgba(76,5,25,0.15)',
      '--radius-sm': '8px',
      '--radius-md': '10px',
      '--radius-lg': '12px',
      '--border-width': '1px',
      '--card-border-width': '1.5px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '1px solid var(--border-color)',
      '--sidebar-border': '1px solid var(--border-color)',
      '--card-shadow': '0 2px 8px rgba(76,5,25,0.08), 0 1px 2px rgba(76,5,25,0.06)',
      '--card-hover-shadow': '0 12px 28px rgba(76,5,25,0.15), 0 4px 8px rgba(76,5,25,0.1)',
      '--btn-shadow': '0 2px 8px rgba(225,29,72,0.3)',
    }
  },
  sand: {
    name: 'Sand',
    desc: 'Warm neutral tones',
    style: 'sand',
    vars: {
      '--bg-primary': '#FAF7F2',
      '--bg-secondary': '#F0EBE1',
      '--bg-sidebar': '#F0EBE1',
      '--bg-header': '#FAF7F2',
      '--bg-card': '#FFFFFF',
      '--bg-input': '#FFFFFF',
      '--bg-hover': '#E8E0D0',
      '--border-color': '#D4C9B8',
      '--border-light': '#F0EBE1',
      '--text-primary': '#3D3425',
      '--text-secondary': '#5C503C',
      '--text-muted': '#8C7D66',
      '--text-faint': '#B5A78F',
      '--accent': '#B45309',
      '--accent-hover': '#92400E',
      '--accent-bg': '#FEF3C7',
      '--accent-text': '#92400E',
      '--success': '#22C55E',
      '--warning': '#F59E0B',
      '--danger': '#EF4444',
      '--shadow': 'rgba(61,52,37,0.08)',
      '--shadow-lg': 'rgba(61,52,37,0.15)',
      '--radius-sm': '8px',
      '--radius-md': '10px',
      '--radius-lg': '12px',
      '--border-width': '1px',
      '--card-border-width': '1.5px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '1px solid var(--border-color)',
      '--sidebar-border': '1px solid var(--border-color)',
      '--card-shadow': '0 2px 8px rgba(61,52,37,0.08), 0 1px 2px rgba(61,52,37,0.06)',
      '--card-hover-shadow': '0 12px 28px rgba(61,52,37,0.15), 0 4px 8px rgba(61,52,37,0.1)',
      '--btn-shadow': '0 2px 8px rgba(180,83,9,0.3)',
    }
  },
  soft: {
    name: 'Soft',
    desc: 'Rounded pastel dreamland',
    style: 'soft',
    vars: {
      '--bg-primary': '#FDF4FF',
      '--bg-secondary': '#FAE8FF',
      '--bg-sidebar': '#FAE8FF',
      '--bg-header': '#FDF4FF',
      '--bg-card': '#FFFFFF',
      '--bg-input': '#FFFFFF',
      '--bg-hover': '#F5D0FE',
      '--border-color': '#F0ABFC',
      '--border-light': '#FAE8FF',
      '--text-primary': '#4A1D6A',
      '--text-secondary': '#6B2F8A',
      '--text-muted': '#A855F7',
      '--text-faint': '#D8B4FE',
      '--accent': '#C084FC',
      '--accent-hover': '#A855F7',
      '--accent-bg': '#FAE8FF',
      '--accent-text': '#9333EA',
      '--success': '#86EFAC',
      '--warning': '#FDE68A',
      '--danger': '#FCA5A5',
      '--shadow': 'rgba(168,85,247,0.08)',
      '--shadow-lg': 'rgba(168,85,247,0.15)',
      '--radius-sm': '14px',
      '--radius-md': '18px',
      '--radius-lg': '24px',
      '--border-width': '2px',
      '--card-border-width': '2px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '500',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '2px solid #F0ABFC',
      '--sidebar-border': '2px solid #F0ABFC',
      '--card-shadow': '0 4px 16px rgba(168,85,247,0.1), 0 2px 4px rgba(168,85,247,0.06)',
      '--card-hover-shadow': '0 16px 40px rgba(168,85,247,0.18), 0 4px 8px rgba(168,85,247,0.1)',
      '--btn-shadow': '0 4px 16px rgba(192,132,252,0.4)',
    }
  },
  mono: {
    name: 'Mono',
    desc: 'Minimalist black & white',
    style: 'mono',
    vars: {
      '--bg-primary': '#FFFFFF',
      '--bg-secondary': '#F5F5F5',
      '--bg-sidebar': '#F5F5F5',
      '--bg-header': '#FFFFFF',
      '--bg-card': '#FFFFFF',
      '--bg-input': '#FFFFFF',
      '--bg-hover': '#EEEEEE',
      '--border-color': '#DDDDDD',
      '--border-light': '#EEEEEE',
      '--text-primary': '#111111',
      '--text-secondary': '#333333',
      '--text-muted': '#777777',
      '--text-faint': '#AAAAAA',
      '--accent': '#111111',
      '--accent-hover': '#333333',
      '--accent-bg': '#F0F0F0',
      '--accent-text': '#111111',
      '--success': '#333333',
      '--warning': '#666666',
      '--danger': '#111111',
      '--shadow': 'rgba(0,0,0,0.06)',
      '--shadow-lg': 'rgba(0,0,0,0.1)',
      '--radius-sm': '2px',
      '--radius-md': '3px',
      '--radius-lg': '4px',
      '--border-width': '1px',
      '--card-border-width': '1px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '500',
      '--font-weight-heavy': '600',
      '--header-border': '1px solid #DDDDDD',
      '--sidebar-border': '1px solid #DDDDDD',
      '--card-shadow': '0 1px 3px rgba(0,0,0,0.06)',
      '--card-hover-shadow': '0 4px 12px rgba(0,0,0,0.1)',
      '--btn-shadow': '0 1px 3px rgba(0,0,0,0.1)',
    }
  },
  grunge: {
    name: 'Grunge',
    desc: 'Rough, weathered, textured',
    style: 'grunge',
    vars: {
      '--bg-primary': '#2A2318',
      '--bg-secondary': '#33291E',
      '--bg-sidebar': '#241E15',
      '--bg-header': '#1E1A12',
      '--bg-card': '#352C22',
      '--bg-input': '#2A2318',
      '--bg-hover': '#3D3328',
      '--border-color': '#504030',
      '--border-light': '#3D3328',
      '--text-primary': '#D4C8B0',
      '--text-secondary': '#B8A888',
      '--text-muted': '#8A7860',
      '--text-faint': '#605040',
      '--accent': '#C8553A',
      '--accent-hover': '#E06848',
      '--accent-bg': 'rgba(200,85,58,0.12)',
      '--accent-text': '#E06848',
      '--success': '#7AA44A',
      '--warning': '#CC9933',
      '--danger': '#C83A3A',
      '--shadow': 'rgba(0,0,0,0.4)',
      '--shadow-lg': 'rgba(0,0,0,0.6)',
      '--radius-sm': '2px',
      '--radius-md': '3px',
      '--radius-lg': '4px',
      '--border-width': '2px',
      '--card-border-width': '2px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '2px solid #504030',
      '--sidebar-border': '2px solid #504030',
      '--card-shadow': '2px 3px 0px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03)',
      '--card-hover-shadow': '3px 4px 0px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
      '--btn-shadow': '2px 3px 0px rgba(0,0,0,0.5)',
    }
  },
  hacker: {
    name: 'Hacker',
    desc: 'Green on black terminal',
    style: 'hacker',
    vars: {
      '--bg-primary': '#0A0A0A',
      '--bg-secondary': '#0F0F0F',
      '--bg-sidebar': '#080808',
      '--bg-header': '#050505',
      '--bg-card': '#111111',
      '--bg-input': '#080808',
      '--bg-hover': '#1A1A1A',
      '--border-color': '#1A3A1A',
      '--border-light': '#0F1F0F',
      '--text-primary': '#00FF41',
      '--text-secondary': '#00CC33',
      '--text-muted': '#008822',
      '--text-faint': '#005518',
      '--accent': '#00FF41',
      '--accent-hover': '#33FF66',
      '--accent-bg': 'rgba(0,255,65,0.06)',
      '--accent-text': '#00FF41',
      '--success': '#00FF41',
      '--warning': '#CCFF00',
      '--danger': '#FF3300',
      '--shadow': 'rgba(0,255,65,0.03)',
      '--shadow-lg': 'rgba(0,255,65,0.06)',
      '--radius-sm': '0px',
      '--radius-md': '0px',
      '--radius-lg': '0px',
      '--border-width': '1px',
      '--card-border-width': '1px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '500',
      '--font-weight-heavy': '600',
      '--header-border': '1px solid #1A3A1A',
      '--sidebar-border': '1px solid #1A3A1A',
      '--card-shadow': '0 0 4px rgba(0,255,65,0.05)',
      '--card-hover-shadow': '0 0 12px rgba(0,255,65,0.1), 0 0 24px rgba(0,255,65,0.03)',
      '--btn-shadow': '0 0 12px rgba(0,255,65,0.2)',
      '--scrollbar-thumb': 'rgba(0,255,65,0.2)',
      '--scrollbar-thumb-hover': 'rgba(0,255,65,0.4)',
    }
  },
  highContrast: {
    name: 'High Contrast',
    desc: 'Maximum readability',
    style: 'highcontrast',
    vars: {
      '--bg-primary': '#000000',
      '--bg-secondary': '#1A1A1A',
      '--bg-sidebar': '#1A1A1A',
      '--bg-header': '#000000',
      '--bg-card': '#1A1A1A',
      '--bg-input': '#000000',
      '--bg-hover': '#333333',
      '--border-color': '#555555',
      '--border-light': '#333333',
      '--text-primary': '#FFFFFF',
      '--text-secondary': '#E0E0E0',
      '--text-muted': '#BBBBBB',
      '--text-faint': '#888888',
      '--accent': '#00BFFF',
      '--accent-hover': '#33CCFF',
      '--accent-bg': 'rgba(0,191,255,0.2)',
      '--accent-text': '#33CCFF',
      '--success': '#00FF7F',
      '--warning': '#FFD700',
      '--danger': '#FF4444',
      '--shadow': 'rgba(255,255,255,0.05)',
      '--shadow-lg': 'rgba(255,255,255,0.1)',
      '--radius-sm': '8px',
      '--radius-md': '10px',
      '--radius-lg': '12px',
      '--border-width': '2px',
      '--card-border-width': '2px',
      '--header-bg': 'var(--bg-header)',
      '--sidebar-bg': 'var(--bg-sidebar)',
      '--card-blur': '0',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '700',
      '--font-weight-heavy': '800',
      '--header-border': '2px solid #555555',
      '--sidebar-border': '2px solid #555555',
      '--card-shadow': '0 0 0 2px #555555',
      '--card-hover-shadow': '0 0 0 2px #00BFFF',
      '--btn-shadow': '0 0 12px rgba(0,191,255,0.4)',
    }
  },
  sunset: {
    name: 'Sunset',
    desc: 'Warm gradient vibes',
    style: 'gradient',
    vars: {
      '--bg-primary': '#1A1020',
      '--bg-secondary': '#241530',
      '--bg-sidebar': '#1E1228',
      '--bg-header': '#1A1020',
      '--bg-card': 'rgba(255,255,255,0.05)',
      '--bg-input': 'rgba(255,255,255,0.04)',
      '--bg-hover': 'rgba(255,255,255,0.08)',
      '--border-color': 'rgba(255,140,80,0.15)',
      '--border-light': 'rgba(255,140,80,0.08)',
      '--text-primary': '#FDE8D8',
      '--text-secondary': '#E8C4AC',
      '--text-muted': '#B08870',
      '--text-faint': '#705040',
      '--accent': '#FF8C50',
      '--accent-hover': '#FFA878',
      '--accent-bg': 'rgba(255,140,80,0.12)',
      '--accent-text': '#FFA878',
      '--success': '#4ADE80',
      '--warning': '#FBBF24',
      '--danger': '#FB7185',
      '--shadow': 'rgba(0,0,0,0.3)',
      '--shadow-lg': 'rgba(0,0,0,0.5)',
      '--radius-sm': '10px',
      '--radius-md': '14px',
      '--radius-lg': '18px',
      '--border-width': '1px',
      '--card-border-width': '1px',
      '--header-bg': 'linear-gradient(135deg, #1A1020, #201530)',
      '--sidebar-bg': 'linear-gradient(180deg, #1E1228, #181025)',
      '--card-blur': '12px',
      '--card-opacity': '1',
      '--font-weight-normal': '400',
      '--font-weight-bold': '600',
      '--font-weight-heavy': '700',
      '--header-border': '1px solid rgba(255,140,80,0.12)',
      '--sidebar-border': '1px solid rgba(255,140,80,0.1)',
      '--card-shadow': '0 4px 20px rgba(255,100,50,0.06), 0 2px 8px rgba(0,0,0,0.2)',
      '--card-hover-shadow': '0 12px 36px rgba(255,100,50,0.12), 0 4px 12px rgba(0,0,0,0.3)',
      '--btn-shadow': '0 4px 16px rgba(255,140,80,0.4)',
    }
  },
};

// Which themes count as dark (for scrollbar styling, etc.)
const DARK_THEMES = ['dark', 'midnight', 'ocean', 'highContrast', 'glass', 'neon', 'nord', 'sunset', 'grunge', 'hacker'];

function applyTheme(themeId) {
  const theme = COLOR_THEMES[themeId];
  if (!theme) return;
  const root = document.documentElement;

  // Apply all CSS custom properties
  for (const [prop, val] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, val);
  }

  // Mark dark/light
  const isDark = DARK_THEMES.includes(themeId);
  // Drive native controls (the <select> dropdown popup, scrollbars, etc.) to match the
  // theme. On Windows, color-scheme — not option {background} — controls the popup color.
  root.style.colorScheme = isDark ? 'dark' : 'light';
  document.body.classList.toggle('theme-dark', isDark);
  document.body.classList.toggle('theme-light', !isDark);
  document.body.dataset.theme = themeId;

  // Apply style class for special visual treatments
  document.body.classList.remove('style-glass', 'style-neon', 'style-brutalist', 'style-soft', 'style-mono', 'style-gradient', 'style-dark', 'style-nord', 'style-midnight', 'style-forest', 'style-ocean', 'style-rose', 'style-sand', 'style-grunge', 'style-hacker', 'style-highcontrast');
  if (theme.style && theme.style !== 'standard') {
    document.body.classList.add('style-' + theme.style);
  }

  // Ambient FX layer
  if (window.ThemeFx) window.ThemeFx.init(themeId);
}

function renderSettings() {
  const container = document.getElementById('view-settings');
  const currentTheme = dataManager.settings.theme || 'default';
  const noteSize = dataManager.settings.noteSize || 'medium';

  container.innerHTML = `
    <div class="settings-page">
      <h2 class="settings-title">Settings</h2>

      <!-- Theme Selection -->
      <div class="settings-section">
        <h3 class="settings-section-title">Color Theme</h3>
        <div class="settings-theme-grid">
          ${Object.entries(COLOR_THEMES).map(([id, theme]) => {
            const previewStyle = theme.style || 'standard';
            const previewRadius = theme.vars['--radius-lg'] || '12px';
            const previewCardRadius = theme.vars['--radius-md'] || '10px';
            const previewBorderW = theme.vars['--card-border-width'] || '1.5px';
            const cardShadow = theme.vars['--card-shadow'] || 'none';
            return `<button class="settings-theme-card ${id === currentTheme ? 'active' : ''}" data-theme="${id}">
              <div class="settings-theme-preview" style="background:${theme.vars['--bg-primary']};border-radius:${previewRadius} ${previewRadius} 0 0">
                <div class="settings-theme-header-bar" style="background:${theme.vars['--bg-header']};border-bottom:${previewBorderW} solid ${theme.vars['--border-color']}">
                  <span style="color:${theme.vars['--accent']};font-size:9px;font-weight:${theme.vars['--font-weight-bold'] || 700}">Tab</span>
                  <span style="color:${theme.vars['--text-muted']};font-size:9px">Tab</span>
                </div>
                <div class="settings-theme-body" style="background:${theme.vars['--bg-secondary']}">
                  <div class="settings-theme-card-preview" style="background:${theme.vars['--bg-card']};border:${previewBorderW} solid ${theme.vars['--border-color']};border-radius:${previewCardRadius};box-shadow:${cardShadow}">
                    <div style="width:60%;height:4px;background:${theme.vars['--text-primary']};border-radius:2px;margin-bottom:3px"></div>
                    <div style="width:40%;height:3px;background:${theme.vars['--text-muted']};border-radius:2px"></div>
                  </div>
                  <div style="width:30px;height:6px;background:${theme.vars['--accent']};border-radius:${theme.vars['--radius-sm'] || '8px'};margin-top:4px"></div>
                </div>
              </div>
              <div class="settings-theme-info">
                <div class="settings-theme-name">${theme.name}</div>
                <div class="settings-theme-desc">${theme.desc}</div>
              </div>
              ${id === currentTheme ? '<div class="settings-theme-check">&#10003;</div>' : ''}
            </button>`;
          }).join('')}
        </div>
      </div>

      <!-- Note Size -->
      <div class="settings-section">
        <h3 class="settings-section-title">Note Card Size</h3>
        <div class="settings-option-row">
          ${['compact', 'medium', 'large'].map(size => `
            <button class="settings-size-btn ${size === noteSize ? 'active' : ''}" data-size="${size}">
              <div class="settings-size-preview settings-size-${size}">
                <div class="settings-size-lines">
                  <div></div><div></div><div></div>
                </div>
              </div>
              <span>${size.charAt(0).toUpperCase() + size.slice(1)}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <!-- General Settings -->
      <div class="settings-section">
        <h3 class="settings-section-title">General</h3>
        <div class="settings-list">
          <label class="settings-toggle-row">
            <span class="settings-toggle-label">Stale task animations</span>
            <span class="settings-toggle-desc">Shake/shiver notes that haven't been touched</span>
            <input type="checkbox" class="settings-checkbox" id="settings-stale-anim" ${dataManager.settings.staleAnimations !== false ? 'checked' : ''}>
          </label>
          <label class="settings-toggle-row">
            <span class="settings-toggle-label">Show day completion dots</span>
            <span class="settings-toggle-desc">Green/yellow/red dots on sidebar days</span>
            <input type="checkbox" class="settings-checkbox" id="settings-day-dots" ${dataManager.settings.dayDots !== false ? 'checked' : ''}>
          </label>
          <label class="settings-toggle-row">
            <span class="settings-toggle-label">Compact sidebar</span>
            <span class="settings-toggle-desc">Reduce sidebar padding and font sizes</span>
            <input type="checkbox" class="settings-checkbox" id="settings-compact-sidebar" ${dataManager.settings.compactSidebar === true ? 'checked' : ''}>
          </label>
          <label class="settings-toggle-row">
            <span class="settings-toggle-label">3D Printer Support</span>
            <span class="settings-toggle-desc">Install the Printer &amp; Slicer utilities, OrcaSlicer proxy, and remote printer controls (also available in the Utility Store)</span>
            <input type="checkbox" class="settings-checkbox" id="settings-printer-enabled" ${dataManager.settings.printerEnabled === true ? 'checked' : ''}>
          </label>
        </div>
      </div>

      <!-- Engineering Utilities -->
      <div class="settings-section">
        <h3 class="settings-section-title">Engineering Utilities</h3>
        <p class="settings-section-desc">DigiKey API credentials used by the KiCad Importer to pull component metadata. Pre-filled with the built-in defaults — override here to use your own.</p>
        <div class="settings-field">
          <label class="settings-field-label">DigiKey Client ID</label>
          <input type="text" class="settings-input" id="settings-digikey-id" placeholder="Client ID">
        </div>
        <div class="settings-field">
          <label class="settings-field-label">DigiKey Client Secret</label>
          <input type="password" class="settings-input" id="settings-digikey-secret" placeholder="Client Secret">
        </div>
        <button id="settings-digikey-save" class="settings-btn">Save DigiKey Credentials</button>
        <span id="settings-digikey-status" class="settings-inline-status"></span>
      </div>

      <!-- Data -->
      <div class="settings-section">
        <h3 class="settings-section-title">Data</h3>
        <div class="settings-data-row">
          <div class="settings-data-stat">
            <span class="settings-data-value">${dataManager.tasks.length}</span>
            <span class="settings-data-label">Notes</span>
          </div>
          <div class="settings-data-stat">
            <span class="settings-data-value">${dataManager.projects.length}</span>
            <span class="settings-data-label">Projects</span>
          </div>
          <div class="settings-data-stat">
            <span class="settings-data-value">${dataManager.purchases?.length || 0}</span>
            <span class="settings-data-label">Purchases</span>
          </div>
          <div class="settings-data-stat">
            <span class="settings-data-value">${dataManager.scheduleItems?.length || 0}</span>
            <span class="settings-data-label">Events</span>
          </div>
        </div>
      </div>

      <!-- Apple Calendar Sync -->
      <div class="settings-section">
        <h3 class="settings-section-title">Apple Calendar Sync</h3>
        <p class="settings-toggle-desc" style="margin-bottom:12px">Scan the QR code with your iPhone camera to auto-subscribe. Events sync every 30 minutes with 15-minute reminders.</p>
        <button id="settings-calendar-link" class="settings-btn" style="padding:8px 20px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:14px;font-weight:600">Generate QR Code</button>
        <span id="settings-calendar-status" style="margin-left:12px;font-size:13px;color:var(--text-muted)"></span>
        <div id="settings-calendar-url" style="display:none;margin-top:16px;padding:16px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px">
          <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
            <div id="settings-calendar-qr" style="background:#fff;padding:12px;border-radius:8px;display:inline-block"></div>
            <div style="flex:1;min-width:200px">
              <p style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px">Scan with your iPhone camera</p>
              <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Point your camera at the QR code. Tap the notification that appears to subscribe to the calendar.</p>
              <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Or copy the link and text it to yourself:</p>
              <div style="display:flex;gap:8px;align-items:center">
                <input id="settings-calendar-url-input" type="text" readonly style="flex:1;padding:8px 12px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:monospace">
                <button id="settings-calendar-copy" class="settings-btn" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;white-space:nowrap">Copy</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Calendar Feeds (Brightspace / ICS) -->
      <div class="settings-section">
        <h3 class="settings-section-title">Calendar Feeds</h3>
        <p class="settings-toggle-desc" style="margin-bottom:12px">Subscribe to external calendars by iCal (ICS) URL. Meeting invites in your connected email accounts are scanned in automatically. Everything refreshes every 15 minutes.</p>
        <div class="settings-feed-guide" style="background:var(--bg-secondary);border:1px solid var(--border-light,var(--border-color));border-radius:12px;padding:14px 16px;margin-bottom:14px">
          <div style="font-size:13px;font-weight:800;color:var(--text-primary);margin-bottom:8px">&#127891; Get your Purdue Brightspace link</div>
          <ol style="margin:0 0 12px 18px;padding:0;font-size:12px;color:var(--text-muted);line-height:1.7">
            <li>Open your Brightspace <b>Calendar</b> (button below).</li>
            <li>Click <b>Subscribe</b> (bottom-left of the calendar).</li>
            <li>Copy the <b>iCal feed URL</b> it gives you.</li>
            <li>Paste it in the box below and click <b>Add</b>.</li>
          </ol>
          <button id="settings-brightspace-open" class="settings-btn" style="padding:7px 16px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;font-weight:600">Open Brightspace Calendar &#8599;</button>
        </div>
        <div id="settings-feeds-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="settings-feed-name" type="text" placeholder="Name (e.g. Brightspace)" style="width:160px;padding:8px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-input);color:var(--text-primary);font-size:13px;font-family:inherit">
          <input id="settings-feed-url" type="text" placeholder="https://purdue.brightspace.com/…/feed.ics?token=…" style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-input);color:var(--text-primary);font-size:13px;font-family:inherit">
          <button id="settings-feed-add" class="settings-btn" style="padding:8px 18px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:14px;font-weight:600">Add</button>
        </div>
        <span id="settings-feed-status" style="display:block;margin-top:10px;font-size:13px;color:var(--text-muted)"></span>
      </div>

      <!-- Mobile Access -->
      <div class="settings-section">
        <h3 class="settings-section-title">Mobile Access</h3>
        <p class="settings-toggle-desc" style="margin-bottom:12px">Scan the QR code with your iPhone camera to open the task board in Safari. Then tap <strong>Share → Add to Home Screen</strong> to get a one-tap app icon for quick note creation.</p>
        <button id="settings-mobile-link" class="settings-btn" style="padding:8px 20px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:14px;font-weight:600">Show QR Code</button>
        <span id="settings-mobile-status" style="margin-left:12px;font-size:13px;color:var(--text-muted)"></span>
        <div id="settings-mobile-url" style="display:none;margin-top:16px;padding:16px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px">
          <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
            <div id="settings-mobile-qr" style="background:#fff;padding:12px;border-radius:8px;display:inline-block"></div>
            <div style="flex:1;min-width:220px">
              <p style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px">Scan with your iPhone camera</p>
              <ol style="font-size:13px;color:var(--text-secondary);margin:0 0 12px 18px;padding:0;line-height:1.6">
                <li>Point your camera at the QR → tap the notification</li>
                <li>Sign in with your account</li>
                <li>Tap <strong>Share</strong> → <strong>Add to Home Screen</strong></li>
                <li>Tap the new icon → add notes from anywhere</li>
              </ol>
              <p style="font-size:12px;color:var(--text-muted);margin:12px 0 4px">Want Siri voice support? <a href="#" id="settings-mobile-siri-link" style="color:var(--accent);text-decoration:none">View setup guide →</a></p>
              <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
                <input id="settings-mobile-url-input" type="text" readonly style="flex:1;padding:8px 12px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:monospace">
                <button id="settings-mobile-copy" class="settings-btn" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;white-space:nowrap">Copy</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- App Distribution -->
      <div class="settings-section">
        <h3 class="settings-section-title">App Distribution</h3>
        <p class="settings-toggle-desc" style="margin-bottom:12px">Build a self-extracting installer (EngOrg-Setup.exe) that you can share with others.</p>
        <button id="settings-build-installer" class="settings-btn" style="padding:8px 20px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:14px;font-weight:600">Build Installer</button>
        <span id="settings-installer-status" style="margin-left:12px;font-size:13px;color:var(--text-muted)"></span>
      </div>

      <div class="settings-section">
        <h3 class="settings-section-title">Contribute</h3>
        <p class="settings-toggle-desc" style="margin-bottom:12px">Improved the app? Submit your local changes as a Pull Request for the owner to review and merge. Requires a GitHub <a href="#" id="settings-contrib-tokenhelp" style="color:var(--accent)">Personal Access Token</a> with <b>repo</b> scope.</p>
        <button id="settings-contrib-open" class="settings-btn" style="padding:8px 20px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:14px;font-weight:600">Submit Changes…</button>
        <a href="#" id="settings-contrib-repo" style="margin-left:12px;font-size:13px;color:var(--accent)">View repository</a>
      </div>
    </div>
  `;

  // Theme click handlers
  container.querySelectorAll('.settings-theme-card').forEach(card => {
    card.addEventListener('click', () => {
      const themeId = card.dataset.theme;
      applyTheme(themeId);
      dataManager.updateSettings({ theme: themeId });
      renderSettings(); // re-render to update active state
    });
  });

  // ── Calendar feeds (Brightspace / ICS) ──
  (function bindCalendarFeeds() {
    const listEl = container.querySelector('#settings-feeds-list');
    const nameEl = container.querySelector('#settings-feed-name');
    const urlEl = container.querySelector('#settings-feed-url');
    const addBtn = container.querySelector('#settings-feed-add');
    const statusEl = container.querySelector('#settings-feed-status');
    const openBtn = container.querySelector('#settings-brightspace-open');
    if (openBtn) openBtn.addEventListener('click', () => window.api.openExternal('https://purdue.brightspace.com/d2l/le/calendar/6606'));
    if (!listEl || !urlEl || !addBtn) return;

    function renderList() {
      const feeds = dataManager.settings.calendarFeeds || [];
      if (!feeds.length) { listEl.innerHTML = '<span style="font-size:13px;color:var(--text-muted)">No calendar feeds yet.</span>'; return; }
      listEl.innerHTML = feeds.map(f => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px">
          <span style="font-weight:600;color:var(--text-primary);font-size:13px">${escapeHtml(f.name || 'Feed')}</span>
          <span style="flex:1;color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.url)}</span>
          <button data-feed-id="${f.id}" class="feed-remove-btn" title="Remove" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:16px;line-height:1">&times;</button>
        </div>`).join('');
      listEl.querySelectorAll('.feed-remove-btn').forEach(b => b.addEventListener('click', async () => {
        const feeds2 = (dataManager.settings.calendarFeeds || []).filter(x => x.id !== b.dataset.feedId);
        await dataManager.updateSettings({ calendarFeeds: feeds2 });
        renderList();
      }));
    }
    renderList();

    addBtn.addEventListener('click', async () => {
      const url = urlEl.value.trim();
      const name = (nameEl.value || '').trim() || (/brightspace/i.test(url) ? 'Brightspace' : 'Calendar');
      if (!url) { statusEl.textContent = 'Enter a feed URL.'; return; }
      const source = /brightspace/i.test(url) ? 'brightspace' : 'feed';
      addBtn.disabled = true; statusEl.textContent = 'Checking feed…';
      try {
        const events = await window.api.calendar.fetchFeed(url, source); // validate before saving
        const feeds = dataManager.settings.calendarFeeds || [];
        feeds.push({ id: 'feed_' + Date.now(), name, url, source });
        await dataManager.updateSettings({ calendarFeeds: feeds });
        urlEl.value = ''; nameEl.value = '';
        renderList();
        statusEl.textContent = `Added — found ${events.length} event(s). Syncing…`;
        if (window.syncCalendars) { try { await window.syncCalendars(); } catch {} }
        statusEl.textContent = `Synced ${events.length} event(s) from ${name}.`;
      } catch (e) {
        statusEl.textContent = 'Could not read that feed: ' + e.message;
      } finally {
        addBtn.disabled = false;
      }
    });
  })();

  // Note size handlers
  container.querySelectorAll('.settings-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.dataset.size;
      document.body.dataset.noteSize = size;
      dataManager.updateSettings({ noteSize: size });
      renderSettings();
    });
  });

  // Toggle handlers
  document.getElementById('settings-stale-anim').addEventListener('change', (e) => {
    dataManager.updateSettings({ staleAnimations: e.target.checked });
    document.body.classList.toggle('no-stale-anim', !e.target.checked);
  });
  document.getElementById('settings-day-dots').addEventListener('change', (e) => {
    dataManager.updateSettings({ dayDots: e.target.checked });
  });
  document.getElementById('settings-compact-sidebar').addEventListener('change', (e) => {
    dataManager.updateSettings({ compactSidebar: e.target.checked });
    document.body.classList.toggle('compact-sidebar', e.target.checked);
  });
  document.getElementById('settings-printer-enabled').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    // Install/uninstall the Printer & Slicer utilities alongside the backend toggle
    let installed = Array.isArray(dataManager.settings.installedUtilities)
      ? [...dataManager.settings.installedUtilities] : [];
    if (enabled) {
      for (const id of ['printer', 'slicer']) if (!installed.includes(id)) installed.push(id);
    } else {
      installed = installed.filter(id => id !== 'printer' && id !== 'slicer');
    }
    await dataManager.updateSettings({ printerEnabled: enabled, installedUtilities: installed });
    // Start/stop backend Fluidd server
    if (window.api?.printer?.setEnabled) {
      await window.api.printer.setEnabled(enabled);
    }
    // Start/stop the always-on camera bridge that streams to the PWA
    if (typeof printerController !== 'undefined') {
      if (enabled) printerController.startBackground();
      else printerController.stopBackground();
    }
  });

  // DigiKey credentials — pre-fill with the built-in defaults if unset
  (async () => {
    const idEl = document.getElementById('settings-digikey-id');
    const secretEl = document.getElementById('settings-digikey-secret');
    if (!idEl || !secretEl) return;
    let id = dataManager.settings.digikeyClientId;
    let secret = dataManager.settings.digikeyClientSecret;
    if ((!id || !secret) && window.api?.kicad?.getDigikeyDefaults) {
      const d = await window.api.kicad.getDigikeyDefaults();
      id = id || d.clientId;
      secret = secret || d.clientSecret;
    }
    idEl.value = id || '';
    secretEl.value = secret || '';
  })();
  const dkSave = document.getElementById('settings-digikey-save');
  if (dkSave) dkSave.addEventListener('click', async () => {
    const id = document.getElementById('settings-digikey-id').value.trim();
    const secret = document.getElementById('settings-digikey-secret').value.trim();
    await dataManager.updateSettings({ digikeyClientId: id, digikeyClientSecret: secret });
    const status = document.getElementById('settings-digikey-status');
    if (status) { status.textContent = 'Saved'; setTimeout(() => { status.textContent = ''; }, 2000); }
  });
  // Apple Calendar link handler
  document.getElementById('settings-calendar-link').addEventListener('click', async () => {
    const btn = document.getElementById('settings-calendar-link');
    const status = document.getElementById('settings-calendar-status');
    const urlBox = document.getElementById('settings-calendar-url');

    if (typeof firebase === 'undefined' || !firebase.auth().currentUser) {
      status.textContent = 'Sign in first to generate a calendar link';
      status.style.color = 'var(--danger)';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Generating...';
    status.textContent = '';

    try {
      const idToken = await firebase.auth().currentUser.getIdToken();
      const resp = await fetch('https://generatecalendartoken-sf7sdunyuq-uc.a.run.app', {
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (!resp.ok) throw new Error('Failed to generate token');
      const { token } = await resp.json();
      // webcal:// triggers iOS calendar subscription prompt automatically
      const webcalUrl = `webcal://calendarfeed-sf7sdunyuq-uc.a.run.app?token=${token}`;

      document.getElementById('settings-calendar-url-input').value = webcalUrl;
      urlBox.style.display = 'block';

      // Generate QR code
      const qrContainer = document.getElementById('settings-calendar-qr');
      qrContainer.innerHTML = '';
      new QRCode(qrContainer, {
        text: webcalUrl,
        width: 180,
        height: 180,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });

      status.textContent = '';
      btn.textContent = 'Regenerate QR Code';
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.style.color = 'var(--danger)';
      btn.textContent = 'Generate QR Code';
    }
    btn.disabled = false;
  });

  // Copy calendar URL
  document.getElementById('settings-calendar-copy').addEventListener('click', () => {
    const input = document.getElementById('settings-calendar-url-input');
    navigator.clipboard.writeText(input.value);
    const copyBtn = document.getElementById('settings-calendar-copy');
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  });

  // Mobile Access QR handler — points to the PWA for home-screen install
  document.getElementById('settings-mobile-link').addEventListener('click', () => {
    const urlBox = document.getElementById('settings-mobile-url');
    const pwaUrl = 'https://assistant-taskboard.firebaseapp.com';

    document.getElementById('settings-mobile-url-input').value = pwaUrl;
    urlBox.style.display = 'block';

    const qrContainer = document.getElementById('settings-mobile-qr');
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
      text: pwaUrl,
      width: 180,
      height: 180,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });

    document.getElementById('settings-mobile-link').textContent = 'Hide QR';
  });

  // Copy mobile URL
  document.getElementById('settings-mobile-copy').addEventListener('click', () => {
    const input = document.getElementById('settings-mobile-url-input');
    navigator.clipboard.writeText(input.value);
    const copyBtn = document.getElementById('settings-mobile-copy');
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  });

  // Open Siri voice setup guide in the default browser
  document.getElementById('settings-mobile-siri-link').addEventListener('click', async (e) => {
    e.preventDefault();
    const status = document.getElementById('settings-mobile-status');
    if (typeof firebase === 'undefined' || !firebase.auth().currentUser) {
      status.textContent = 'Sign in first to get your API token';
      status.style.color = 'var(--danger)';
      return;
    }
    try {
      const idToken = await firebase.auth().currentUser.getIdToken();
      const resp = await fetch('https://assistant-taskboard.firebaseapp.com/api/generateApiToken', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { token } = await resp.json();
      if (!token) throw new Error('No token returned');
      const guideUrl = `https://assistant-taskboard.firebaseapp.com/shortcuts-setup?token=${token}`;
      if (window.api && window.api.openExternal) {
        window.api.openExternal(guideUrl);
      } else {
        window.open(guideUrl, '_blank');
      }
      status.textContent = '';
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.style.color = 'var(--danger)';
    }
  });

  document.getElementById('settings-build-installer').addEventListener('click', async () => {
    const btn = document.getElementById('settings-build-installer');
    const status = document.getElementById('settings-installer-status');
    btn.disabled = true;
    btn.textContent = 'Building...';
    status.textContent = 'This may take a few minutes...';
    status.style.color = 'var(--text-muted)';
    try {
      const result = await window.api.installer.build();
      if (result.success) {
        status.textContent = `Created: ${result.path}`;
        status.style.color = 'var(--success)';
      } else {
        status.textContent = `Error: ${result.error}`;
        status.style.color = 'var(--danger)';
      }
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      status.style.color = 'var(--danger)';
    }
    btn.disabled = false;
    btn.textContent = 'Build Installer';
  });

  // ── Contribute (submit local changes as a GitHub PR) ──
  bindContribute();
}

function bindContribute() {
  const openBtn = document.getElementById('settings-contrib-open');
  const repoLink = document.getElementById('settings-contrib-repo');
  const tokenHelp = document.getElementById('settings-contrib-tokenhelp');
  if (repoLink) repoLink.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal('https://github.com/carsonbellak/engorg-taskboard'); });
  if (tokenHelp) tokenHelp.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal('https://github.com/settings/tokens/new?scopes=repo&description=EngOrg'); });
  if (!openBtn) return;
  openBtn.addEventListener('click', openContributeModal);
}

async function openContributeModal() {
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  const ov = document.createElement('div');
  ov.className = 'wifi-modal-overlay';
  ov.innerHTML = `
    <div class="wifi-modal" style="max-width:680px">
      <div class="wifi-modal-title">Submit Changes</div>
      <div class="wifi-modal-section">
        <label>Changed files (vs upstream <code>main</code>)</label>
        <div id="contrib-files" class="wifi-meter-list" style="max-height:240px">Scanning…</div>
      </div>
      <div class="wifi-modal-section">
        <label>Pull request title</label>
        <input id="contrib-title" class="kicad-input" placeholder="Short summary of your changes">
        <label>Description</label>
        <textarea id="contrib-body" class="kicad-input" rows="3" placeholder="What did you change and why?"></textarea>
      </div>
      <div class="wifi-modal-section">
        <label>GitHub Personal Access Token (<b>repo</b> scope)</label>
        <input id="contrib-token" class="kicad-input" type="password" placeholder="ghp_… (leave blank if previously saved)">
        <label class="wifi-cb"><input type="checkbox" id="contrib-remember"> Remember this token on this device (encrypted)</label>
      </div>
      <div id="contrib-status" class="settings-section-desc"></div>
      <div class="wifi-modal-actions">
        <button id="contrib-cancel" class="kicad-btn kicad-btn-outline">Cancel</button>
        <button id="contrib-submit" class="kicad-btn kicad-btn-start">Open Pull Request</button>
      </div>
    </div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);

  const filesEl = ov.querySelector('#contrib-files');
  const statusEl = ov.querySelector('#contrib-status');
  ov.querySelector('#contrib-cancel').addEventListener('click', () => ov.remove());

  // saved-token hint
  try { const t = await window.api.contribute.hasToken(); if (t.hasToken) ov.querySelector('#contrib-token').placeholder = 'Using saved token (type to override)'; } catch {}

  // load changes
  let changes = [];
  try {
    const res = await window.api.contribute.getChanges();
    if (res.error) { filesEl.innerHTML = `<div class="kicad-empty">${esc(res.error)}</div>`; }
    else {
      changes = res.changes || [];
      if (!changes.length) filesEl.innerHTML = '<div class="kicad-empty">No differences from upstream — nothing to submit.</div>';
      else filesEl.innerHTML = changes.map((c, i) => `
        <label class="wifi-meter-row"><input type="checkbox" data-i="${i}" checked>
          <span><b style="color:var(--${c.status === 'added' ? 'success' : c.status === 'deleted' ? 'danger' : 'accent'})">${c.status[0].toUpperCase()}</b> ${esc(c.path)}</span></label>`).join('');
    }
  } catch (e) { filesEl.innerHTML = `<div class="kicad-empty">${esc(e.message)}</div>`; }

  ov.querySelector('#contrib-submit').addEventListener('click', async () => {
    const picked = [...filesEl.querySelectorAll('input:checked')].map((c) => changes[+c.dataset.i]);
    const title = ov.querySelector('#contrib-title').value.trim();
    const body = ov.querySelector('#contrib-body').value.trim();
    const token = ov.querySelector('#contrib-token').value.trim();
    const saveToken = ov.querySelector('#contrib-remember').checked;
    if (!picked.length) { statusEl.textContent = 'Select at least one file.'; statusEl.style.color = 'var(--danger)'; return; }
    if (!title) { statusEl.textContent = 'Enter a PR title.'; statusEl.style.color = 'var(--danger)'; return; }
    const btn = ov.querySelector('#contrib-submit');
    btn.disabled = true; statusEl.style.color = 'var(--text-muted)'; statusEl.textContent = 'Forking, committing, and opening PR… (this can take a few seconds)';
    try {
      const res = await window.api.contribute.submit({ token: token || undefined, title, body, files: picked, saveToken });
      if (res.error) { statusEl.textContent = 'Error: ' + res.error; statusEl.style.color = 'var(--danger)'; btn.disabled = false; return; }
      statusEl.innerHTML = `✓ Pull request #${res.number} opened. <a href="#" id="contrib-prlink" style="color:var(--accent)">View it on GitHub</a>`;
      statusEl.style.color = 'var(--success)';
      const link = ov.querySelector('#contrib-prlink');
      if (link) link.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(res.url); });
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message; statusEl.style.color = 'var(--danger)'; btn.disabled = false;
    }
  });
}

// Printer & Slicer are now installable utilities inside the always-visible
// Engineering Utilities tab, so there are no dedicated tabs to show/hide.
// Kept as a no-op for backward-compatible call sites.
function updatePrinterTabVisibility() {}

// Apply saved theme on load
function initTheme() {
  const theme = dataManager.settings.theme || 'default';
  applyTheme(theme);
  const noteSize = dataManager.settings.noteSize || 'medium';
  document.body.dataset.noteSize = noteSize;
  if (dataManager.settings.staleAnimations === false) {
    document.body.classList.add('no-stale-anim');
  }
  if (dataManager.settings.compactSidebar) {
    document.body.classList.add('compact-sidebar');
  }
  // Show/hide printer & slicer tabs
  updatePrinterTabVisibility(dataManager.settings.printerEnabled === true);
}
