# UML-диаграммы голосовой конференции

---

## 1. Диаграмма вариантов использования (Use Case)

```mermaid
graph LR
    UC1["Войти в комнату"]
    UC2["Выйти из комнаты"]
    UC3["Говорить"]
    UC4["Слушать"]
    UC5["Отправить сообщение в чат"]
    UC6["Загрузить файл"]
    UC7["Переключить микрофон"]
    UC8["Установить время комнаты"]
    UC9["Просматривать список участников"]
    UC10["Просматривать качество связи"]

    P((Участник)) --> UC1
    P --> UC2
    P --> UC3
    P --> UC4
    P --> UC5
    P --> UC6
    P --> UC7
    P --> UC9
    P --> UC10

    A((Администратор сервера)) --> UC8
    A --> UC9

    UC1 --> UC3
    UC1 --> UC4
    UC3 -.-> UC7
```

**Описание:** Участник может входить в комнату, говорить, слушать, отправлять сообщения, загружать файлы и переключать микрофон. Администратор устанавливает время жизни комнаты и просматривает участников.

---

## 2. Диаграмма классов (Class Diagram)

```mermaid
classDiagram
    class Room {
        +String id
        +String code
        +Number ttl
        +Map peers
        +timer
        +addPeer(peer)
        +removePeer(peerId)
        +broadcast(message, excludeId)
    }

    class Peer {
        +String id
        +WebSocket ws
        +String roomId
        +Boolean audioEnabled
        +send(data)
    }

    class Server {
        +Map rooms
        +httpServer
        +WebSocketServer wss
        +handleUpgrade(req, socket, head)
        +onConnection(ws)
    }

    class Client {
        +WebSocket ws
        +String peerId
        +AudioContext audioCtx
        +ScriptProcessorNode processor
        +MediaStream micStream
        +Array playQueue
        +startMic()
        +stopMic()
        +sendMessage(data)
    }

    class AudioCapture {
        +ScriptProcessorNode processor
        +Number bufSize
        +Number sampleRate
        +onaudioprocess(event)
        +resample(data, fromRate, toRate)
    }

    class AudioPlayback {
        +AudioContext audioCtx
        +Array playQueue
        +Number nextPlayTime
        +playChunk(samples)
        +schedulePlayback()
    }

    Server "1" --> "*" Room : управляет
    Room "1" --> "*" Peer : содержит
    Client --> Peer : создаёт
    Client --> AudioCapture : использует
    Client --> AudioPlayback : использует
```

**Описание:** Сервер управляет комнатами, каждая комната содержит участников. Клиент создаёт Peer-объект и использует компоненты захвата и воспроизведения аудио.

---

## 3. Диаграмма последовательности — вход в комнату

```mermaid
sequenceDiagram
    actor U as Участник
    participant B as Браузер
    participant S as Сервер

    U->>B: Переходит по ссылке /room/код
    B->>B: getUserMedia({audio: true})
    B->>S: GET /api/room/код
    S-->>B: { roomId, peerId }

    B->>S: WebSocket: {type: "join", roomId, peerId}
    S->>S: Создаёт Peer, добавляет в Room
    S-->>B: {type: "joined", peers: [...]}

    loop Для каждого существующего пира
        S-->>B: {type: "peer_joined", peerId}
    end

    B->>B: Запуск захвата микрофона
    B->>B: ScriptProcessorNode → WS send
```

**Описание:** Браузер запрашивает доступ к микрофону, подключается к серверу через WebSocket, получает список участников и уведомления о присоединившихся пирах.

---

## 4. Диаграмма последовательности — передача голоса

```mermaid
sequenceDiagram
    participant M as Микрофон
    participant SP as ScriptProcessorNode
    participant C as Клиент WS
    participant S as Сервер
    participant P as Все пиры

    M->>SP: onaudioprocess(Float32Array)
    SP->>SP: Ресемплинг 44100→8000 Hz
    SP->>SP: Int16 буфер
    C->>S: WS binary: Int16 samples

    S->>S: Получает аудио-фрейм

    loop Каждый пир в комнате
        S->>P: WS binary: Int16 samples
    end

    P->>P: Int16 → Float32
    P->>P: Создание AudioBuffer
    P->>P: Планирование воспроизведения
```

**Описание:** Микрофон захватывает звук, ScriptProcessorNode ресемплирует до 8 кГц, кодирует в Int16 и отправляет через WebSocket. Сервер ретранслирует всем остальным пирам.

---

## 5. Диаграмма последовательности — чат

```mermaid
sequenceDiagram
    actor U as Участник
    participant B as Браузер
    participant S as Сервер
    participant P as Все пиры

    U->>B: Вводит сообщение, нажимает Enter
    B->>S: WS: {type:"chat", peerId, text, ts}
    S->>S: Сохраняет в истории

    loop Каждый пир в комнате
        S->>P: WS: {type:"chat", peerId, text, ts}
    end

    P->>P: UI: отображение сообщения в чате
```

**Описание:** Участник отправляет текстовое сообщение через WebSocket. Сервер ретранслирует его всем участникам комнаты, которые отображают сообщение в интерфейсе чата.

---

## 6. Диаграмма последовательности — загрузка файла

```mermaid
sequenceDiagram
    actor U as Участник
    participant B as Браузер
    participant S as Сервер (multer)
    participant P as Все пиры

    U->>B: Выбирает файл
    B->>S: POST /upload (multipart/form-data)
    S->>S: multer: сохраняет файл на диск
    S-->>B: {url: "/files/file.webm"}

    B->>S: WS: {type:"file_share", peerId, fileName, url}
    S->>S: Уведомление в историю

    loop Каждый пир в комнате
        S->>P: WS: {type:"file_share", peerId, fileName, url}
    end

    P->>P: UI: отображение ссылки на файл
```

**Описание:** Участник загружает файл через HTTP POST с multipart/form-data. Сервер сохраняет файл и рассылает ссылку на него всем участникам комнаты через WebSocket.

---

## 7. Диаграмма последовательности — выход из комнаты

```mermaid
sequenceDiagram
    actor U as Участник
    participant B as Браузер
    participant S as Сервер
    participant P as Остальные пиры

    U->>B: Нажимает «Выйти»
    B->>S: WS: {type: "leave", peerId}

    S->>S: Удаляет Peer из Room
    S->>S: Останавливает таймер (если пусто)

    loop Каждый оставшийся пир
        S->>P: {type: "peer_left", peerId}
    end

    S-->>B: {type: "left"}
    B->>B: Остановка микрофона
    B->>B: Закрытие WebSocket
    B->>B: Очистка AudioContext
```

**Описание:** Участник нажимает кнопку выхода. Сервер удаляет пира из комнаты, уведомляет остальных и закрывает соединение. Клиент останавливает захват аудио и освобождает ресурсы.

---

## 8. Диаграмма состояний — жизненный цикл комнаты

```mermaid
stateDiagram-v2
    [*] --> Создание : Создание комнаты
    Создание --> Активна : Первый участник вошёл
    Активна --> Ожидание_участников : Все вышли
    Ожидание_участников --> Активна : Новый участник
    Активна --> Закрыта_по_таймеру : TTL истёк
    Ожидание_участников --> Закрыта_по_таймеру : TTL истёк
    Закрыта_по_таймеру --> Удалена : Уборка
    Удалена --> [*]
```

**Описание:** Комната создаётся при первом входе, становится активной, переходит в ожидание, когда все выходят. По истечении TTL комната закрывается и удаляется.

---

## 9. Диаграмма состояний — подключение участника

```mermaid
stateDiagram-v2
    [*] --> Лобби
    Лобби --> Захват_микрофона : Разрешение getUserMedia
    Захват_микрофона --> Подключение_WS : Микрофон захвачен
    Захват_микрофона --> Лобби : Доступ отклонён
    Подключение_WS --> В_комнате : joined
    В_комнате --> Говорит : audioEnabled + spoken
    В_комнате --> Молчит : !audioEnabled
    Говорит --> Молчит : Выключил микрофон
    Молчит --> Говорит : Включил микрофон
    В_комнате --> Вышел : leave / таймер
    Говорит --> Вышел : leave / таймер
    Молчит --> Вышел : leave / таймер
    Вышел --> [*]
```

**Описание:** Участник проходит через лобби, захват микрофона, подключение к WebSocket. В комнате может говорить или молчать, затем выходит.

---

## 10. Диаграмма состояний — аудио процесс

```mermaid
stateDiagram-v2
    [*] --> Ожидание
    Ожидание --> Захват : onaudioprocess
    Захват --> Ресемплинг : Float32 получены
    Ресемплинг --> Fade : 44100→8000 Hz
    Fade --> Отправка : Int16 буфер
    Отправка --> Ожидание_следующего : WS отправлен
    Ожидание_следующего --> Ожидание : 20мс интервал
    Ожидание_следующего --> [*] : Остановка
```

**Описание:** Цикл обработки аудио: захват буфера с микрофона, ресемплинг до 8 кГц, применение fade-in/out, отправка через WebSocket и ожидание следующего фрейма.

---

## 11. Диаграмма компонентов (Component Diagram)

```mermaid
graph TB
    subgraph Сервер ["Сервер (Node.js)"]
        WEB["Web Server\nExpress + SSL"]
        WSS["WebSocket Server\n(ws)"]
        RM["Room Manager"]
        FU["File Upload\n(multer)"]
        AR["Audio Relay"]
    end

    subgraph Клиент ["Клиент"]
        WC["Web Client\nHTML / CSS / JS"]
        EW["Electron Wrapper\nmain.js"]
        AV["Android WebView"]
    end

    WC --> WEB
    WC --> WSS
    EW --> WC
    AV --> WC
    WSS --> RM
    WSS --> AR
    WEB --> FU
    RM --> AR
```

**Описание:** Сервер включает HTTP-сервер (Express), WebSocket-сервер (ws), менеджер комнат, загрузку файлов (multer) и ретрансляцию аудио. Клиенты: браузерный Web Client, Electron и Android WebView.

---

## 12. Диаграмма развёртывания (Deployment Diagram)

```mermaid
graph TB
    subgraph VM ["VM Debian 12 (87.242.117.240)"]
        OS["Debian 12"]
        ND["Node.js 18"]
        SYSD["systemd"]
        SVC["node server.js\n:8443 (HTTPS)\n:8080 (WSS)"]
    end

    subgraph CD ["Клиентские устройства"]
        CH["Chrome Desktop\n(Windows/Linux)"]
        CA["Chrome Android"]
        EL["Electron\n(Windows/Linux)"]
        AN["Android App\nWebView"]
    end

    subgraph NET ["Сеть"]
        HTTPS["HTTPS :8443"]
        WSS["WSS :8080"]
    end

    CH -->|HTTPS| HTTPS
    CA -->|HTTPS| HTTPS
    EL -->|HTTPS| HTTPS
    AN -->|HTTPS| HTTPS
    HTTPS --> VM
    WSS --> VM
    CH -->|WSS| WSS
    CA -->|WSS| WSS
    EL -->|WSS| WSS
    AN -->|WSS| WSS
```

**Описание:** Сервер развёрнут на VM Debian 12 с Node.js 18 и systemd. Клиенты подключаются через HTTPS (8443) и WSS (8080). Поддерживаются Chrome Desktop, Chrome Android, Electron и Android App.

---

## 13. Диаграмма потоков данных (DFD Level 0)

```mermaid
graph LR
    M["Микрофон\n(Вход)"] --> Z["Захват\nаудио"]
    Z --> R["Ресемплинг\n8 kHz"]
    R --> WS["WebSocket\nSend"]
    WS --> S["Server\nRelay"]
    S --> WR["WebSocket\nReceive"]
    WR --> JB["Jitter\nBuffer"]
    JB --> PB["Playback"]
    PB --> SP["Динамик\n(Выход)"]

    style M fill:#adf,stroke:#333
    style SP fill:#fda,stroke:#333
    style S fill:#fad,stroke:#333
```

**Описание:** Поток данных от микрофона к динамику: захват аудио, ресемплинг до 8 кГц, отправка через WebSocket, ретрансляция сервером, приём, jitter-буфер и воспроизведение.

---

## 14. Диаграмма пакетов (Package Diagram)

```mermaid
graph TB
    subgraph PKG1 ["server/"]
        SJ["server.js"]
        PJ["package.json"]
        PJ2["package-lock.json"]
    end

    subgraph PKG2 ["web/"]
        IH["index.html"]
        CSS["css/"]
        JS["js/"]
    end

    subgraph PKG3 ["web/js/"]
        APP["app.js"]
    end

    subgraph PKG4 ["desktop/"]
        MJ["main.js"]
        PJ3["package.json"]
    end

    subgraph PKG5 ["android/"]
        AN["app/"]
    end

    subgraph PKG6 ["docs/"]
        UML["uml/"]
        GOST["gost/"]
    end

    PKG1 ..> PKG2 : отдаёт HTML/JS
    PKG2 --> PKG3
    PKG4 ..> PKG1 : подключается
    PKG5 ..> PKG2 : WebView
    PKG6 ..> PKG1 : документация
```

**Описание:** Пакетная структура проекта: `server/` — серверная часть, `web/` — клиентская (HTML, CSS, JS), `desktop/` — Electron, `android/` — Android-приложение, `docs/` — документация.

---

## 15. Диаграмма activities — обработка аудио-фрейма

```mermaid
flowchart TD
    A([Начало]) --> B[Получен бинарный фрейм]
    B --> C[Int16 → Float32]
    C --> D{AudioContext\nсуществует?}
    D -->|Да| F[Создание AudioBuffer]
    D -->|Нет| E[Создание AudioContext]
    E --> F
    F --> G[Планирование\nвоспроизведения]
    G --> H[Jitter Buffer\nожидание]
    H --> I[Fade-in / Fade-out]
    I --> J[Playback\nAudioBufferSourceNode]
    J --> K([Конец])
```

**Описание:** При получении бинарного фрейма данные конвертируются из Int16 в Float32, проверяется наличие AudioContext, создаётся AudioBuffer, планируется воспроизведение через jitter-буфер с fade-in/out.
