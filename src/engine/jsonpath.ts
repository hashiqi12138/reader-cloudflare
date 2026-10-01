/**
 * 极简 JSONPath
 *
 * Legado 书源里的 JSONPath 规则（`@json:` 或 `$.` 开头）实际只用得到一小撮语法，
 * 引一个通用库反而要背上它整个表达式引擎的体积。这里只实现够用的部分：
 *
 *   $.data.list[*].title     逐层取键、通配
 *   $.data.list[0].name      取第 n 个
 *   $['a-b'].c               键名含特殊字符时用引号
 *   $..name                  递归下降，取任意层级的 name
 *
 * **不实现** `[?(@.price<10)]` 这类过滤器表达式：遇到时明确返回空并记日志，
 * 而不是悄悄返回一个看起来像结果的东西。
 */

type Token =
  | { type: 'key'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' }
  | { type: 'deep'; name: string }

export class JsonPathUnsupportedError extends Error {}

function tokenize(expr: string): Token[] {
  let i = 0
  const s = expr.trim()
  if (s.startsWith('$')) i = 1

  const tokens: Token[] = []
  while (i < s.length) {
    const ch = s[i]!

    if (ch === '.') {
      if (s[i + 1] === '.') {
        // 递归下降
        i += 2
        if (s[i] === '*') {
          tokens.push({ type: 'deep', name: '*' })
          i++
          continue
        }
        const start = i
        while (i < s.length && /[\w$@-]/.test(s[i]!)) i++
        if (i === start) throw new JsonPathUnsupportedError(`无法解析 JSONPath：${expr}`)
        tokens.push({ type: 'deep', name: s.slice(start, i) })
        continue
      }
      i++
      if (s[i] === '*') {
        tokens.push({ type: 'wildcard' })
        i++
        continue
      }
      const start = i
      while (i < s.length && /[\w$@-]/.test(s[i]!)) i++
      if (i === start) throw new JsonPathUnsupportedError(`无法解析 JSONPath：${expr}`)
      tokens.push({ type: 'key', name: s.slice(start, i) })
      continue
    }

    if (ch === '[') {
      const close = s.indexOf(']', i)
      if (close === -1) throw new JsonPathUnsupportedError(`方括号未闭合：${expr}`)
      const inner = s.slice(i + 1, close).trim()
      i = close + 1

      if (inner === '*') {
        tokens.push({ type: 'wildcard' })
      } else if (/^-?\d+$/.test(inner)) {
        tokens.push({ type: 'index', index: Number(inner) })
      } else if (/^'.*'$/.test(inner) || /^".*"$/.test(inner)) {
        tokens.push({ type: 'key', name: inner.slice(1, -1) })
      } else if (inner.startsWith('?')) {
        throw new JsonPathUnsupportedError(`暂不支持过滤器表达式：[${inner}]`)
      } else {
        throw new JsonPathUnsupportedError(`无法解析方括号内容：[${inner}]`)
      }
      continue
    }

    // 出现了无法识别的内容，直接停下而不是猜
    break
  }

  return tokens
}

function collectDeep(node: unknown, name: string, out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDeep(item, name, out)
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (name === '*' || k === name) out.push(v)
    collectDeep(v, name, out)
  }
}

/** 按 JSONPath 取值，返回所有命中的节点（可能是 0 个、1 个或多个） */
export function queryJsonPath(root: unknown, expr: string): unknown[] {
  const tokens = tokenize(expr)
  let current: unknown[] = [root]

  for (const token of tokens) {
    const next: unknown[] = []
    for (const node of current) {
      switch (token.type) {
        case 'key': {
          if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
            const v = (node as Record<string, unknown>)[token.name]
            if (v !== undefined) next.push(v)
          }
          break
        }
        case 'index': {
          if (Array.isArray(node)) {
            const idx = token.index < 0 ? node.length + token.index : token.index
            if (idx >= 0 && idx < node.length) next.push(node[idx])
          }
          break
        }
        case 'wildcard': {
          if (Array.isArray(node)) next.push(...node)
          else if (node !== null && typeof node === 'object') next.push(...Object.values(node))
          break
        }
        case 'deep': {
          collectDeep(node, token.name, next)
          break
        }
      }
    }
    current = next
  }

  return current
}

/** 把 JSONPath 结果转成字符串列表 */
export function jsonPathToStrings(root: unknown, expr: string): string[] {
  return queryJsonPath(root, expr)
    .filter((v) => v !== null && v !== undefined)
    .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
}
