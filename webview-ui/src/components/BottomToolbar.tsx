import { useState, useEffect, useRef } from 'react'
import { SettingsModal } from './SettingsModal.js'
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js'
import { vscode } from '../vscodeApi.js'

const CLI_OPTIONS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'cursor', label: 'Cursor' },
] as const

type CliType = typeof CLI_OPTIONS[number]['id']

interface BottomToolbarProps {
  isEditMode: boolean
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  workspaceFolders: WorkspaceFolder[]
  selectedCli: string
  onSelectedCliChange: (cli: string) => void
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
}

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '24px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
}


export function BottomToolbar({
  isEditMode,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  workspaceFolders,
  selectedCli,
  onSelectedCliChange,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [isCliPickerOpen, setIsCliPickerOpen] = useState(false)
  const [hoveredFolder, setHoveredFolder] = useState<number | null>(null)
  const [hoveredCliIdx, setHoveredCliIdx] = useState<number | null>(null)
  const folderPickerRef = useRef<HTMLDivElement>(null)
  const cliPickerRef = useRef<HTMLDivElement>(null)

  // Close pickers on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isCliPickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (isFolderPickerOpen && folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false)
      }
      if (isCliPickerOpen && cliPickerRef.current && !cliPickerRef.current.contains(e.target as Node)) {
        setIsCliPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isFolderPickerOpen, isCliPickerOpen])

  const hasMultipleFolders = workspaceFolders.length > 1
  const selectedCliLabel = CLI_OPTIONS.find(c => c.id === selectedCli)?.label || 'Agent'

  const handleAgentClick = () => {
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v)
      setIsCliPickerOpen(false)
    } else {
      // Single-folder: send openClaude with selected CLI type
      vscode.postMessage({ type: 'openClaude', cliType: selectedCli })
    }
  }

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false)
    vscode.postMessage({ type: 'openClaude', folderPath: folder.path, cliType: selectedCli })
  }

  const handleCliArrowClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsCliPickerOpen((v) => !v)
    setIsFolderPickerOpen(false)
  }

  const handleCliSelect = (cli: CliType) => {
    onSelectedCliChange(cli)
    setIsCliPickerOpen(false)
  }

  return (
    <div style={panelStyle}>
      {/* Split button: main + dropdown arrow */}
      <div ref={cliPickerRef} style={{ position: 'relative', display: 'flex' }}>
        <div ref={folderPickerRef} style={{ position: 'relative' }}>
          <button
            onClick={handleAgentClick}
            onMouseEnter={() => setHovered('agent')}
            onMouseLeave={() => setHovered(null)}
            style={{
              ...btnBase,
              padding: '5px 12px',
              paddingRight: 6,
              background:
                hovered === 'agent' || isFolderPickerOpen
                  ? 'var(--pixel-agent-hover-bg)'
                  : 'var(--pixel-agent-bg)',
              border: '2px solid var(--pixel-agent-border)',
              borderRight: 'none',
              color: 'var(--pixel-agent-text)',
            }}
            title={`Add ${selectedCliLabel} agent`}
          >
            + {selectedCliLabel}
          </button>
          {isFolderPickerOpen && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                marginBottom: 4,
                background: 'var(--pixel-bg)',
                border: '2px solid var(--pixel-border)',
                borderRadius: 0,
                boxShadow: 'var(--pixel-shadow)',
                minWidth: 160,
                zIndex: 'var(--pixel-controls-z)',
              }}
            >
              {workspaceFolders.map((folder, i) => (
                <button
                  key={folder.path}
                  onClick={() => handleFolderSelect(folder)}
                  onMouseEnter={() => setHoveredFolder(i)}
                  onMouseLeave={() => setHoveredFolder(null)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 10px',
                    fontSize: '22px',
                    color: 'var(--pixel-text)',
                    background: hoveredFolder === i ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                    border: 'none',
                    borderRadius: 0,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {folder.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Dropdown arrow button */}
        <button
          onClick={handleCliArrowClick}
          onMouseEnter={() => setHovered('cli-arrow')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            padding: '5px 6px',
            paddingLeft: 4,
            fontSize: '18px',
            background:
              hovered === 'cli-arrow' || isCliPickerOpen
                ? 'var(--pixel-agent-hover-bg)'
                : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            borderLeft: '1px solid var(--pixel-agent-border)',
            color: 'var(--pixel-agent-text)',
          }}
          title="Select CLI type"
        >
          &#9662;
        </button>
        {/* CLI picker dropdown */}
        {isCliPickerOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 160,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            {CLI_OPTIONS.map((cli, i) => (
              <button
                key={cli.id}
                onClick={() => handleCliSelect(cli.id)}
                onMouseEnter={() => setHoveredCliIdx(i)}
                onMouseLeave={() => setHoveredCliIdx(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontSize: '22px',
                  color: 'var(--pixel-text)',
                  background: hoveredCliIdx === i ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{
                  width: 16,
                  textAlign: 'center',
                  color: selectedCli === cli.id ? 'var(--pixel-accent)' : 'transparent',
                }}>
                  {selectedCli === cli.id ? '\u2022' : ''}
                </span>
                {cli.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        Layout
      </button>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => !v)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background: hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
        />
      </div>
    </div>
  )
}
