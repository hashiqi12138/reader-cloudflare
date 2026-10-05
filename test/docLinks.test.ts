/*
 * 文档指针的防漂移测试
 *
 * README 现在只放项目介绍，实现细节与轮次记录搬去了 `EXPERIENCE.md`。搬动时仓库里有
 * 三十多处「见 README 第七十三轮」这类指针要跟着改 —— 这类错**不会报错**，只是让照着
 * 注释去查的人翻不到东西，而且下次再搬一次就会重犯。
 *
 * 所以这里机械地查两件事：
 *   1. 源码 / 前端 / 脚本 / 测试里提到的文档名，那个文件真的在（改文件名忘改引用会红）
 *   2. README 保持「项目介绍」这一层 —— 里面不该再出现「第 N 轮」（那些在 EXPERIENCE.md）
 *
 * 具体指哪一节没法机械校验（标题会改），所以只查「文件在不在」与「分层有没有被破坏」。
 */

import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url)

const read = (relative: string) => readFileSync(new URL(relative, root), 'utf8')

const readme = read('README.md')
const experience = read('EXPERIENCE.md')

/** 递归列出目录下的文件（相对仓库根的路径用 `/`） */
function filesUnder(dir: string, extensions: string[]): string[] {
    const out: string[] = []
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
        const path = `${dir}${entry.name}`
        if (entry.isDirectory()) out.push(...filesUnder(`${path}/`, extensions))
        else if (extensions.some((one) => entry.name.endsWith(one))) out.push(path)
    }
    return out
}

/** 会被扫的目录：注释里提到文档名的就是这些地方 */
const SCANNED = [
    ...filesUnder('src/', ['.ts']),
    ...filesUnder('public/', ['.js', '.html']),
    ...filesUnder('test/', ['.ts', '.mjs']),
    ...filesUnder('scripts/', ['.mjs']),
    ...filesUnder('migrations/', ['.sql']),
]

const DOC_NAMES = ['README.md', 'EXPERIENCE.md', 'DOCKER.md', 'TODO.md']

/** 「第 N 轮」——轮次编号在标题里是中文数字（`第七十九轮`），正文里偶尔是阿拉伯数字 */
const ROUND_REF = /第[〇零一二三四五六七八九十百]+轮|第\s*\d+\s*轮/

describe('文档指针', () => {
    it('扫到的文件不为空（否则这条测试是空转的）', () => {
        expect(SCANNED.length).toBeGreaterThan(50)
    })

    it('代码 / 脚本 / 测试里提到的文档名都真的存在', () => {
        for (const file of SCANNED) {
            const text = read(file)
            for (const name of DOC_NAMES) {
                if (!text.includes(name)) continue
                // 只为「这个文件在不在」——不存在就说明有引用没跟着改名
                expect(() => read(name), `${file} 里提到了 ${name}，但那个文件不在`).not.toThrow()
            }
        }
    })

    /**
     * 这两条断的是**分层**，所以先把两个大文件折成布尔再断言 ——
     * 直接对 64 万字的字符串做 toMatch，失败时 vitest 会把整份内容打进输出里。
     */
    it('README 里不再出现「第 N 轮」—— 轮次记录在 EXPERIENCE.md', () => {
        expect(ROUND_REF.test(readme)).toBe(false)
    })

    it('EXPERIENCE.md 里确实带着轮次记录', () => {
        expect(ROUND_REF.test(experience)).toBe(true)
    })

    it('两份文档互相指向对方（免得只有一边知道另一边存在）', () => {
        expect(readme.includes('EXPERIENCE.md')).toBe(true)
        expect(experience.includes('README.md')).toBe(true)
    })
})
