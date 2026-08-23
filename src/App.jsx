import React, { useCallback, useRef, useState } from 'react'
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

let idc = 1
const uid = () => idc++

export default function App() {
  const sheetRef = useRef(null)
  const fileRef = useRef(null)

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

  // 画像ゾーン内ドラッグでパン
  const imgDragRef = useRef(null)
  const onImgPointerDown = (e) => {
    if (!image) return
    e.currentTarget.setPointerCapture(e.pointerId)
    imgDragRef.current = { sx: e.clientX, sy: e.clientY, ox: imgT.x, oy: imgT.y }
  }
  const onImgPointerMove = (e) => {
    if (!imgDragRef.current) return
    const d = imgDragRef.current
    const dx = (e.clientX - d.sx) / zoom
    const dy = (e.clientY - d.sy) / zoom
    setImgT((t) => ({ ...t, x: d.ox + dx, y: d.oy + dy }))
  }
  const onImgPointerUp = (e) => {
    imgDragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
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
    const dx = (e.clientX - d.sx) / zoom
    const dy = (e.clientY - d.sy) / zoom
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
    const dx = (e.clientX - d.sx) / zoom
    const dy = (e.clientY - d.sy) / zoom
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

  const savePng = async () => {
    try {
      setBusy(true)
      setSelected(null)
      await new Promise((r) => setTimeout(r, 60))
      const url = await capture()
      const a = document.createElement('a')
      a.href = url
      a.download = `${buildName(meta)}.png`
      a.click()
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
      // 印刷セーフ余白を除いた領域に、比率を維持して全体を収める
      const availW = pw - PDF_MARGIN * 2
      const availH = ph - PDF_MARGIN * 2
      const ratio = Math.min(availW / SHEET_W, availH / SHEET_H)
      const w = SHEET_W * ratio
      const h = SHEET_H * ratio
      pdf.addImage(url, 'PNG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST')
      pdf.save(`${buildName(meta)}.pdf`)
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
          <button onClick={() => fileRef.current?.click()}>🖼 画像を選択</button>
          <button onClick={addNote}>💬 コメント追加</button>
        </div>
        <div className="tb-group">
          <label className="zoom">
            表示
            <input
              type="range" min="0.4" max="1.4" step="0.05"
              value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
            />
            {Math.round(zoom * 100)}%
          </label>
        </div>
        <div className="tb-group right">
          <button className="ghost" onClick={clearAll}>🗑 全消去</button>
          <button className="primary" disabled={busy} onClick={savePng}>⬇ PNG保存</button>
          <button className="primary" disabled={busy} onClick={savePdf}>⬇ PDF保存</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickImage} />
      </header>

      {/* ===== ワークスペース ===== */}
      <div className="workspace">
        <div className="sheet-scaler" style={{ transform: `scale(${zoom})` }}>
          {/* ---- キャプチャ対象の用紙 ---- */}
          <div
            className="sheet"
            ref={sheetRef}
            style={{ width: SHEET_W, height: SHEET_H }}
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
                  <div className="hint">クリックして選択 / ドラッグで移動 / ホイールで拡大縮小</div>
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
                onDragOver={(e) => onNoteDragOver(e, n.id)}
                onDragLeave={(e) => onNoteDragLeave(e, n.id)}
                onDrop={(e) => onNoteDrop(e, n.id)}
              >
                <div className="note-bar">
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
                    className="note-x note-btn"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeNote(n.id)}
                  >×</button>
                </div>
                {n.img && (
                  <div className="note-img-wrap">
                    <img className="note-img" src={n.img} alt="参考資料" draggable={false} />
                    <button
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
                />
              </div>
            ))}

            {/* 右下：尺・コマ数 */}
            <div className="footage-box">
              <div className="footage-title">尺 / コマ数</div>
              <div className="footage-row">
                <span className="fl">尺</span>
                <input
                  className="fi" value={footage.sec}
                  onChange={(e) => setFootage({ ...footage, sec: e.target.value })}
                />
                <span className="fu">秒 +</span>
                <input
                  className="fi" value={footage.frame}
                  onChange={(e) => setFootage({ ...footage, frame: e.target.value })}
                />
                <span className="fu">コマ</span>
              </div>
              <div className="footage-row">
                <span className="fl">コマ数</span>
                <input
                  className="fi wide" value={footage.koma}
                  onChange={(e) => setFootage({ ...footage, koma: e.target.value })}
                />
                <span className="fu">コマ</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {busy && <div className="overlay">保存中…</div>}
    </div>
  )
}

function Field({ label, value, onChange, w }) {
  return (
    <label className="hfield" style={{ width: w }}>
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
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
