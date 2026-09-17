import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toPng } from 'html-to-image'
import { jsPDF } from 'jspdf'

// ---- 用紙サイズ（A4 横 相当 @96dpi）----
const SHEET_W = 1123
const SHEET_H = 794

// 出力解像度倍率（3 ≈ 300dpi 相当。印刷用にくっきり）
const PRINT_SCALE = 3

// PDF の印刷セーフ余白（pt）。プリンタの印刷不可領域で端が切れないように確保
const PDF_MARGIN = 22

// 16:9 画像ゾーンの既定サイズ・位置（用紙内座標）
const ZONE_W = 896
const ZONE_H = Math.round((ZONE_W * 9) / 16) // 504
const ZONE_X = 40
const ZONE_Y = 84

const NOTE_COLORS = ['#fff9c4', '#c8e6c9', '#ffcdd2', '#bbdefb', '#ffffff']

const isIosLike = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

let idc = 1
const uid = () => idc++

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const mid2 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export default function App() {
  const sheetRef = useRef(null)
  const fileRef = useRef(null)
  const noteFileRef = useRef(null)
  const workspaceRef = useRef(null)
  const noteAttachId = useRef(null)

  // ヘッダー情報
  const [meta, setMeta] = useState({
    title: '',
    cut: '',
    scene: '',
    author: '',
  })

  // 画像とその変形（ゾーン内でのパン・ズーム）
  const [image, setImage] = useState(null) // dataURL
  const [imgT, setImgT] = useState({ x: 0, y: 0, scale: 1 })

  // コメント付箋
  const [notes, setNotes] = useState([])
  const [selected, setSelected] = useState(null)
  const [dragOver, setDragOver] = useState(null) // 画像D&D中の付箋ID

  // 尺・コマ数
  const [footage, setFootage] = useState({ sec: '', frame: '', koma: '' })

  // 表示ズーム
  const [zoom, setZoom] = useState(0.85)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(null)

  const imgTRef = useRef(imgT)
  imgTRef.current = imgT
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  const fitToScreen = useCallback(() => {
    const el = workspaceRef.current
    if (!el) return
    const pad = 20
    const z = Math.min(
      (el.clientWidth - pad * 2) / SHEET_W,
      (el.clientHeight - pad * 2) / SHEET_H,
      1.4,
    )
    setZoom(Math.max(0.2, Number(z.toFixed(3))))
  }, [])

  useEffect(() => {
    const run = () => fitToScreen()
    run()
    const raf = requestAnimationFrame(() => requestAnimationFrame(run))
    const t = setTimeout(run, 80)
    let lastW = window.innerWidth
    const onResize = () => {
      // 幅が大きく変わったときだけ（向き変更）。キーボード表示の高さ変化では触らない
      if (Math.abs(window.innerWidth - lastW) < 40) return
      lastW = window.innerWidth
      fitToScreen()
    }
    const onOrient = () => setTimeout(fitToScreen, 250)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onOrient)
    screen.orientation?.addEventListener?.('change', onOrient)

    const preventGesture = (e) => e.preventDefault()
    document.addEventListener('gesturestart', preventGesture, { passive: false })
    document.addEventListener('gesturechange', preventGesture, { passive: false })
    document.addEventListener('gestureend', preventGesture, { passive: false })

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onOrient)
      screen.orientation?.removeEventListener?.('change', onOrient)
      document.removeEventListener('gesturestart', preventGesture)
      document.removeEventListener('gesturechange', preventGesture)
      document.removeEventListener('gestureend', preventGesture)
    }
  }, [fitToScreen])

  // ---------- 画像 ----------
  const onPickImage = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      setImage(reader.result)
      setImgT({ x: 0, y: 0, scale: 1 })
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  const imgPtrs = useRef(new Map())
  const imgDragRef = useRef(null)
  const pinchRef = useRef(null)
  const lastTapRef = useRef(0)

  const onImgPointerDown = (e) => {
    if (!image) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    imgPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const t = imgTRef.current
    const pts = [...imgPtrs.current.values()]
    if (pts.length >= 2) {
      imgDragRef.current = null
      const [a, b] = pts
      pinchRef.current = {
        dist: dist2(a, b),
        mid: mid2(a, b),
        scale: t.scale,
        ox: t.x,
        oy: t.y,
      }
      return
    }
    imgDragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      ox: t.x,
      oy: t.y,
      moved: false,
    }
  }
  const onImgPointerMove = (e) => {
    if (!imgPtrs.current.has(e.pointerId)) return
    imgPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...imgPtrs.current.values()]
    if (pinchRef.current && pts.length >= 2) {
      const [a, b] = pts
      const d = pinchRef.current
      const scale = Math.min(6, Math.max(0.2, d.scale * (dist2(a, b) / (d.dist || 1))))
      const mid = mid2(a, b)
      const z = zoomRef.current
      const dx = (mid.x - d.mid.x) / z
      const dy = (mid.y - d.mid.y) / z
      setImgT({ x: d.ox + dx, y: d.oy + dy, scale })
      return
    }
    if (!imgDragRef.current) return
    const d = imgDragRef.current
    const dx = (e.clientX - d.sx) / zoomRef.current
    const dy = (e.clientY - d.sy) / zoomRef.current
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    setImgT((t) => ({ ...t, x: d.ox + dx, y: d.oy + dy }))
  }
  const onImgPointerUp = (e) => {
    imgPtrs.current.delete(e.pointerId)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    if (imgPtrs.current.size < 2) pinchRef.current = null
    if (imgPtrs.current.size === 1) {
      const [p] = imgPtrs.current.values()
      const t = imgTRef.current
      imgDragRef.current = { sx: p.x, sy: p.y, ox: t.x, oy: t.y, moved: true }
    } else if (imgPtrs.current.size === 0) {
      const d = imgDragRef.current
      if (d && !d.moved) {
        const now = Date.now()
        if (now - lastTapRef.current < 350) {
          setImgT({ x: 0, y: 0, scale: 1 })
          lastTapRef.current = 0
        } else {
          lastTapRef.current = now
        }
      }
      imgDragRef.current = null
    }
  }
  const onImgWheel = (e) => {
    if (!image) return
    e.preventDefault()
    const delta = -e.deltaY * 0.0012
    setImgT((t) => ({ ...t, scale: Math.min(6, Math.max(0.2, t.scale + delta)) }))
  }

  // ---------- コメント ----------
  const addNote = () => {
    const n = {
      id: uid(),
      x: ZONE_X + (notes.length % 3) * 235,
      y: ZONE_Y + ZONE_H + 16 + Math.floor(notes.length / 3) * 12,
      w: 220,
      h: 100,
      text: '',
      color: NOTE_COLORS[0],
    }
    setNotes((s) => [...s, n])
    setSelected(n.id)
  }
  const updateNote = (id, patch) =>
    setNotes((s) => s.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  const removeNote = (id) => {
    setNotes((s) => s.filter((n) => n.id !== id))
    if (selected === id) setSelected(null)
  }

  const onNotePickImage = (e) => {
    const f = e.target.files?.[0]
    const id = noteAttachId.current
    e.target.value = ''
    if (!f || id == null) return
    const reader = new FileReader()
    reader.onload = () => updateNote(id, { img: reader.result })
    reader.readAsDataURL(f)
  }
  const attachNoteImage = (id) => {
    noteAttachId.current = id
    noteFileRef.current?.click()
  }

  // 付箋への画像ドラッグ＆ドロップ（参考資料の添付）
  const onNoteDragOver = (e, id) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (dragOver !== id) setDragOver(id)
  }
  const onNoteDragLeave = (e, id) => {
    if (dragOver === id) setDragOver(null)
  }
  const onNoteDrop = (e, id) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)
    const f = Array.from(e.dataTransfer?.files || []).find((f) => f.type.startsWith('image/'))
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => updateNote(id, { img: reader.result })
    reader.readAsDataURL(f)
  }

  // 付箋ドラッグ
  const noteDrag = useRef(null)
  const onNotePointerDown = (e, n) => {
    if (e.target.closest('.note-body') || e.target.closest('.note-btn')) return
    e.stopPropagation()
    setSelected(n.id)
    e.currentTarget.setPointerCapture(e.pointerId)
    noteDrag.current = { id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y }
  }
  const onNotePointerMove = (e) => {
    const d = noteDrag.current
    if (!d) return
    const dx = (e.clientX - d.sx) / zoomRef.current
    const dy = (e.clientY - d.sy) / zoomRef.current
    updateNote(d.id, { x: d.ox + dx, y: d.oy + dy })
  }
  const onNotePointerUp = (e) => {
    noteDrag.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
  }

  // 付箋リサイズ
  const resizeDrag = useRef(null)
  const onResizeDown = (e, n) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeDrag.current = { id: n.id, sx: e.clientX, sy: e.clientY, ow: n.w, oh: n.h }
  }
  const onResizeMove = (e) => {
    const d = resizeDrag.current
    if (!d) return
    const dx = (e.clientX - d.sx) / zoomRef.current
    const dy = (e.clientY - d.sy) / zoomRef.current
    updateNote(d.id, {
      w: Math.max(120, d.ow + dx),
      h: Math.max(70, d.oh + dy),
    })
  }
  const onResizeUp = (e) => {
    resizeDrag.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
  }

  // ---------- 出力 ----------
  const capture = useCallback(async () => {
    const node = sheetRef.current
    return await toPng(node, {
      pixelRatio: PRINT_SCALE,
      backgroundColor: '#ffffff',
      width: SHEET_W,
      height: SHEET_H,
      style: { transform: 'none', margin: '0' },
    })
  }, [])

  const exportBlob = async (blob, filename) => {
    const file = new File([blob], filename, { type: blob.type })
    // Windows の Chrome/Edge も share に対応しているため、共有シートは iOS 系だけに限定する
    if (isIosLike() && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename })
        return
      } catch (err) {
        if (err.name === 'AbortError') return
      }
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (isIosLike()) {
      // iPad Safari は download を無視し、非同期後の window.open もブロックされやすい
      setPending((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url)
        return { blob, filename, url }
      })
      return
    }
    setTimeout(() => URL.revokeObjectURL(url), 20000)
  }

  const sharePending = async () => {
    if (!pending) return
    const file = new File([pending.blob], pending.filename, { type: pending.blob.type })
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: pending.filename })
        URL.revokeObjectURL(pending.url)
        setPending(null)
        return
      }
    } catch (err) {
      if (err.name === 'AbortError') return
    }
    window.open(pending.url, '_blank')
  }

  const dismissPending = () => {
    if (pending?.url) URL.revokeObjectURL(pending.url)
    setPending(null)
  }

  const savePng = async () => {
    try {
      setBusy(true)
      setSelected(null)
      await new Promise((r) => setTimeout(r, 60))
      const dataUrl = await capture()
      const blob = await (await fetch(dataUrl)).blob()
      await exportBlob(blob, `${buildName(meta)}.png`)
    } catch (err) {
      alert('PNG保存に失敗しました: ' + err)
    } finally {
      setBusy(false)
    }
  }

  const savePdf = async () => {
    try {
      setBusy(true)
      setSelected(null)
      await new Promise((r) => setTimeout(r, 60))
      const url = await capture()
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
      const pw = pdf.internal.pageSize.getWidth()
      const ph = pdf.internal.pageSize.getHeight()
      const availW = pw - PDF_MARGIN * 2
      const availH = ph - PDF_MARGIN * 2
      const ratio = Math.min(availW / SHEET_W, availH / SHEET_H)
      const w = SHEET_W * ratio
      const h = SHEET_H * ratio
      pdf.addImage(url, 'PNG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST')
      const blob = pdf.output('blob')
      await exportBlob(blob, `${buildName(meta)}.pdf`)
    } catch (err) {
      alert('PDF保存に失敗しました: ' + err)
    } finally {
      setBusy(false)
    }
  }

  const clearAll = () => {
    if (!confirm('画像・コメント・記入内容をすべて消去します。よろしいですか？')) return
    setImage(null)
    setImgT({ x: 0, y: 0, scale: 1 })
    setNotes([])
    setSelected(null)
    setFooter()
  }
  const setFooter = () => setFootage({ sec: '', frame: '', koma: '' })

  return (
    <div className="app">
      {/* ===== ツールバー（キャプチャ対象外） ===== */}
      <header className="toolbar">
        <div className="brand">🎬 レイアウト / 作画指示用紙</div>
        <div className="tb-group">
          <button type="button" onClick={() => fileRef.current?.click()}>🖼 画像を選択</button>
          <button type="button" onClick={addNote}>💬 コメント追加</button>
        </div>
        <div className="tb-group">
          <label className="zoom">
            表示
            <input
              type="range" min="0.2" max="1.4" step="0.05"
              value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
            />
            {Math.round(zoom * 100)}%
          </label>
          <button type="button" className="ghost" onClick={fitToScreen}>画面に合わせる</button>
        </div>
        <div className="tb-group right">
          <button type="button" className="ghost" onClick={clearAll}>🗑 全消去</button>
          <button type="button" className="primary" disabled={busy} onClick={savePng}>⬇ PNG保存</button>
          <button type="button" className="primary" disabled={busy} onClick={savePdf}>⬇ PDF保存</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickImage} />
        <input ref={noteFileRef} type="file" accept="image/*" hidden onChange={onNotePickImage} />
      </header>

      {/* ===== ワークスペース ===== */}
      <div className="workspace" ref={workspaceRef}>
        <div
          className="sheet-scaler"
          style={{ width: SHEET_W * zoom, height: SHEET_H * zoom }}
        >
          {/* ---- キャプチャ対象の用紙 ---- */}
          <div
            className="sheet"
            ref={sheetRef}
            style={{ width: SHEET_W, height: SHEET_H, transform: `scale(${zoom})` }}
            onPointerDown={() => setSelected(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => e.preventDefault()}
          >
            {/* ヘッダー欄 */}
            <div className="sheet-head">
              <Field label="作品名" value={meta.title} onChange={(v) => setMeta({ ...meta, title: v })} w={260} />
              <Field label="シーン" value={meta.scene} onChange={(v) => setMeta({ ...meta, scene: v })} w={110} />
              <Field label="カット" value={meta.cut} onChange={(v) => setMeta({ ...meta, cut: v })} w={110} />
              <Field label="作画" value={meta.author} onChange={(v) => setMeta({ ...meta, author: v })} w={140} />
            </div>

            {/* 16:9 画像ゾーン */}
            <div
              className="image-zone"
              style={{ left: ZONE_X, top: ZONE_Y, width: ZONE_W, height: ZONE_H }}
              onPointerDown={(e) => { e.stopPropagation(); onImgPointerDown(e) }}
              onPointerMove={onImgPointerMove}
              onPointerUp={onImgPointerUp}
              onPointerCancel={onImgPointerUp}
              onWheel={onImgWheel}
            >
              {image ? (
                <img
                  className="zone-img"
                  src={image}
                  alt="layout"
                  draggable={false}
                  style={{
                    transform: `translate(${imgT.x}px, ${imgT.y}px) scale(${imgT.scale})`,
                  }}
                />
              ) : (
                <div className="zone-placeholder" onClick={() => fileRef.current?.click()}>
                  <div className="zone-plus">＋</div>
                  <div>16:9 の画像をここに貼り込み</div>
                  <div className="hint">タップ／クリックで選択 · ドラッグで移動 · ピンチまたはホイールで拡大</div>
                </div>
              )}
              <div className="zone-ratio">16:9</div>
            </div>

            {/* コメント付箋 */}
            {notes.map((n) => (
              <div
                key={n.id}
                className={
                  'note' +
                  (selected === n.id ? ' selected' : '') +
                  (dragOver === n.id ? ' dragover' : '')
                }
                style={{ left: n.x, top: n.y, width: n.w, height: n.h, background: n.color }}
                onPointerDown={(e) => onNotePointerDown(e, n)}
                onPointerMove={onNotePointerMove}
                onPointerUp={onNotePointerUp}
                onPointerCancel={onNotePointerUp}
                onDragOver={(e) => onNoteDragOver(e, n.id)}
                onDragLeave={(e) => onNoteDragLeave(e, n.id)}
                onDrop={(e) => onNoteDrop(e, n.id)}
              >
                <div className="note-bar">
                  <div className="note-grip" aria-hidden>⋮⋮</div>
                  <div className="note-colors">
                    {NOTE_COLORS.map((c) => (
                      <span
                        key={c}
                        className="swatch note-btn"
                        style={{ background: c }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => updateNote(n.id, { color: c })}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="note-attach note-btn"
                    title="画像を添付"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => attachNoteImage(n.id)}
                  >📎</button>
                  <button
                    type="button"
                    className="note-x note-btn"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeNote(n.id)}
                  >×</button>
                </div>
                {n.img && (
                  <div className="note-img-wrap">
                    <img className="note-img" src={n.img} alt="参考資料" draggable={false} />
                    <button
                      type="button"
                      className="note-img-x note-btn"
                      title="画像を削除"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => updateNote(n.id, { img: null })}
                    >×</button>
                  </div>
                )}
                <textarea
                  className="note-body"
                  placeholder="コメント・作画指示を入力…"
                  value={n.text}
                  onChange={(e) => updateNote(n.id, { text: e.target.value })}
                  onPointerDown={(e) => e.stopPropagation()}
                />
                {dragOver === n.id && (
                  <div className="note-drop-hint">画像をドロップして添付</div>
                )}
                <div
                  className="note-resize note-btn"
                  onPointerDown={(e) => onResizeDown(e, n)}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeUp}
                  onPointerCancel={onResizeUp}
                />
              </div>
            ))}

            {/* 右下：尺・コマ数 */}
            <div className="footage-box">
              <div className="footage-title">尺 / コマ数</div>
              <div className="footage-row">
                <span className="fl">尺</span>
                <input
                  className="fi" value={footage.sec} inputMode="decimal"
                  onChange={(e) => setFootage({ ...footage, sec: e.target.value })}
                />
                <span className="fu">秒 +</span>
                <input
                  className="fi" value={footage.frame} inputMode="decimal"
                  onChange={(e) => setFootage({ ...footage, frame: e.target.value })}
                />
                <span className="fu">コマ</span>
              </div>
              <div className="footage-row">
                <span className="fl">コマ数</span>
                <input
                  className="fi wide" value={footage.koma} inputMode="decimal"
                  onChange={(e) => setFootage({ ...footage, koma: e.target.value })}
                />
                <span className="fu">コマ</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {pending && (
        <div className="share-bar">
          <span>{pending.filename} の保存準備ができました</span>
          <button type="button" className="primary" onClick={sharePending}>共有</button>
          <button type="button" onClick={() => window.open(pending.url, '_blank')}>開く</button>
          <button type="button" className="ghost" onClick={dismissPending}>閉じる</button>
        </div>
      )}
      {busy && <div className="overlay">保存中…</div>}
    </div>
  )
}

function Field({ label, value, onChange, w }) {
  return (
    <label className="hfield" style={{ width: w }}>
      <span>{label}</span>
      <input
        value={value}
        enterKeyHint="done"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

// ファイル名 = シーン名 + カット番号（例: "S1_C24"）
function buildName(meta) {
  const clean = (s) =>
    (s || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_')
  const scene = clean(meta.scene)
  const cut = clean(meta.cut)
  let name = [scene, cut].filter(Boolean).join('_')
  if (!name) {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    name = `layout_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
  }
  return name
}
