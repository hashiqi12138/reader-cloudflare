/**
 * 书源注册表
 *
 * 当前阶段只提供内置的测试站点。真正要用的书源由使用者自己导入 ——
 * 规则引擎是中立的，具体指向哪个站点是使用者的选择。
 *
 * 后续接入 D1 后，这里会变成「内置源 + 用户导入源」的合并视图，
 * 因此现在就把「取一张表」和「按 id 找一条」这两件事拆成函数，
 * 到时候只改实现、不动调用方。
 */

import type { BookSource } from '../engine/types'

export interface RegisteredSource extends BookSource {
  /** 稳定标识。内置源用 `builtin:` 前缀，避免与用户导入的地址型 id 撞车 */
  id: string
  /** 是否内置（内置源不可删除，也不进用户的书源管理列表） */
  builtin: boolean
}

/** 内置测试站点的书源定义。地址随请求来源变化，因此按 origin 现造 */
export function fixtureSource(origin: string): RegisteredSource {
  return {
    id: 'builtin:fixture',
    builtin: true,
    bookSourceName: '内置测试站点',
    bookSourceUrl: origin,
    bookSourceGroup: '测试',
    bookSourceComment: '项目自带的测试站点，用于验证引擎链路，不含任何第三方内容',
    bookSourceType: 0,
    enabled: true,

    searchUrl: `${origin}/fixture/search?q={{key}}&p={{page}}`,
    ruleSearch: {
      bookList: '@css:div.result-item',
      name: '@css:h3.title@text',
      author: '@css:span.author@text',
      kind: '@css:span.kind@text',
      intro: '@css:p.intro@text',
      bookUrl: '@css:h3.title a@href',
    },
    ruleBookInfo: {
      name: '@css:h1.book-name@text',
      author: '@css:span.book-author@text',
      intro: '@css:div.book-intro@text',
      tocUrl: '@css:a.toc-link@href',
    },
    ruleToc: {
      chapterList: '@css:ul.chapter-list li',
      chapterName: '@css:a@text',
      chapterUrl: '@css:a@href',
    },
    ruleContent: {
      content: '@css:div#content@textNodes',
    },
  }
}

/** 当前可用的书源列表 */
export function listSources(origin: string): RegisteredSource[] {
  return [fixtureSource(origin)]
}

/** 按 id 取一条书源 */
export function findSource(origin: string, id: string): RegisteredSource | undefined {
  return listSources(origin).find((s) => s.id === id)
}
