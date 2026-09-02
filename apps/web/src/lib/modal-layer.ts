/**
 * 겹쳐 뜬 모달 레이어(Drawer, 확인 다이얼로그 등)의 스택.
 *
 * 레이어마다 window에 Esc/Tab 핸들러를 달면, Drawer 위에 확인 다이얼로그가 열렸을 때
 * Esc 한 번으로 둘 다 닫히고 Tab 트랩이 서로 경합한다.
 * 각 레이어는 마운트 시 push하고, 자기가 최상단일 때만 키를 처리한다.
 */

const stack: symbol[] = [];

/** 레이어를 스택 맨 위에 올리고 식별자를 돌려준다. */
export function pushModalLayer(label: string): symbol {
  const id = Symbol(label);
  stack.push(id);
  return id;
}

/** 레이어를 스택에서 제거한다. 이미 없으면 아무 것도 하지 않는다. */
export function popModalLayer(id: symbol): void {
  const index = stack.lastIndexOf(id);
  if (index >= 0) stack.splice(index, 1);
}

/** 이 레이어가 최상단인가. 최상단만 Esc/Tab을 처리해야 한다. */
export function isTopModalLayer(id: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}
