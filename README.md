# usage-band

Claude Code mod: 입력창 바로 위에 구독 사용량(5h / 7d 남은 %, 리셋까지 남은 시간)과 컨텍스트 사용률(ctx %, 토큰)을 한 줄로 실시간 표시합니다.

- 데스크톱 Code 탭: 아이콘 + SVG 게이지 바, 항목 사이 `│` 구분선
- 터미널: `5h:77% (02:13) | 7d:60% (3 12:00) | ctx 42% (84K / 200K)`

## 값의 출처와 갱신 주기

| 항목 | 출처 | 갱신 |
|---|---|---|
| Claude 5h·7d | `https://api.anthropic.com/api/oauth/usage` 직접 조회(앱 사용량 화면과 같은 값). 인증은 `$.session.authorize()` 핸들이라 토큰이 mod에 오지 않음 | 1분. 실패하면 5분 쉬고 재시도, 그동안은 엔진 값 |
| ctx | 분자: 마지막 응답의 입력 토큰. 분모: `/context`와 같은 자동 압축 창(`breakdown: 'summary'`) | 5초(값이 바뀔 때만 다시 그림). 분모는 1분 |
| Codex 5h·7d | `chatgpt.com/backend-api/wham/usage` | 1분 |

엔진이 응답마다 넘기는 사용량(응답 헤더)은 정수로 잘려 앱보다 1%p 낮게 나올 수 있어 직접 조회 값을 우선합니다.

## 사용

```bash
claude --plugin-dir <이 폴더의 상위 폴더>
```

또는 환경변수 `CLAUDE_CODE_PLUGIN_DIRS`에 상위 폴더 경로를 추가합니다.
