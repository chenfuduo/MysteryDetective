import { applyUndoableChanges, type ReviewUndo } from './reviewActions'
import { listPeople, organizationTextKey, type PersonRecord } from './vault'

async function currentPerson(scriptId: string, personId: string) {
  if (!scriptId || !personId) throw new Error('请先选择当前剧本中的人物')
  const people = await listPeople(scriptId)
  const person = people.find(item => item.id === personId && item.scriptId === scriptId)
  if (!person) throw new Error('当前剧本中找不到该人物，请关闭后重新打开')
  return { people, person }
}
const namesOf = (person: PersonRecord) => [person.name, ...person.aliases, ...(person.ocrNames || [])]

export async function savePersonOcrName(scriptId: string, personId: string, wrongName: string): Promise<ReviewUndo> {
  const value = wrongName.trim(), key = organizationTextKey(value)
  if (!key) throw new Error('请输入照片中被识别错的姓名')
  const { people, person } = await currentPerson(scriptId, personId)
  if ([person.name, ...person.aliases].some(name => organizationTextKey(name) === key)) throw new Error('这个姓名已经是该人物的姓名或别名，无需添加纠错')
  if ((person.ocrNames || []).some(name => organizationTextKey(name) === key)) throw new Error('这个识别错名已经添加过了')
  const other = people.find(item => item.id !== person.id && namesOf(item).some(name => organizationTextKey(name) === key))
  if (other) throw new Error(`“${value}”已属于人物“${other.name}”，请先核对或合并人物`)
  return applyUndoableChanges(scriptId, `将识别错名“${value}”匹配到“${person.name}”`, [{
    kind: 'people', id: person.id, before: person, after: { ...person, ocrNames: [...(person.ocrNames || []), value] },
  }])
}

export async function removePersonOcrName(scriptId: string, personId: string, wrongName: string): Promise<ReviewUndo> {
  const { person } = await currentPerson(scriptId, personId)
  if (!(person.ocrNames || []).includes(wrongName)) throw new Error('这条识别纠错已经移除，请重新打开查看')
  return applyUndoableChanges(scriptId, `移除“${person.name}”的识别错名“${wrongName}”`, [{
    kind: 'people', id: person.id, before: person, after: { ...person, ocrNames: (person.ocrNames || []).filter(name => name !== wrongName) },
  }])
}
