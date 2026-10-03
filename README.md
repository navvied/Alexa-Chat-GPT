# Alexa Chat GPT

Skill Alexa buatan sendiri yang menjawab pakai **ChatGPT**, dan jalan di **server milikmu sendiri**.
Tanpa Lambda, tanpa skill pihak ketiga, dan tanpa dependency npm (cukup Node.js).

Ada dua pilihan "otak":

| | `CHAT_PROVIDER=openai` | `CHAT_PROVIDER=hermes` (disarankan) |
|---|---|---|
| Otak | OpenAI API langsung | [Hermes Agent](https://hermes-agent.nousresearch.com) milikmu, login ChatGPT/Codex |
| Biaya | API dibayar per pemakaian | Memakai kuota langganan ChatGPT (tanpa API key OpenAI) |
| Ingatan | Selama percakapan berlangsung | Selama percakapan + **ingatan jangka panjang** (nama, kebiasaan, obrolan lama) |
| Info terbaru | Tidak bisa | **Web search** |
| Kecepatan | Cepat | Lebih lambat (berpikir + mencari), jadi lebih sering "say continue" |

```
"Alexa, open chat buddy"
        │
        ▼
  Echo ──► Amazon Alexa ──HTTPS──► servermu (nginx/Caddy :443) ──► layanan ini (:8787) ──► Hermes (profile alexa)
                                                                         │                   atau OpenAI API
                         jawaban dibacakan + kartu teks di aplikasi Alexa ◄┘
```

## Yang bisa dilakukan

- **Ngobrol bebas** lewat Echo, dengan pertanyaan lanjutan yang nyambung.
- **Percakapan tidak putus saat mic tertutup.** Alexa menutup mic setelah beberapa detik diam, tapi percakapan tetap
  diingat selama **15 menit** sejak pertanyaan terakhir. Jadi *"Alexa, ask chat buddy and what about tomorrow?"*
  beberapa menit kemudian masih nyambung. Bilang **"start over"** untuk topik baru.
- **Per orang.** Kalau anggota rumah punya *voice profile* di Alexa, tiap orang punya percakapan sendiri.
- **Jawaban panjang tidak hilang.** Alexa hanya menunggu 8 detik. Kalau jawabannya lebih lama, Alexa bilang
  *"Say continue"*. Bilang **"continue"**, atau buka skill lagi nanti, untuk mendengar jawabannya.
- **"Let me think."** diucapkan otomatis kalau jawaban butuh lebih dari 1,5 detik.
- **Kartu di aplikasi Alexa** berisi teks lengkap, termasuk link dan kode yang tidak dibacakan.
- **Aman.** Setiap request dicek tanda tangan digital Amazon, stempel waktu (anti replay), dan Skill ID. Di mode Hermes,
  layanan **menolak jalan** kalau Hermes masih membuka tool berbahaya (lihat [Keamanan](#keamanan)).

## Batasan yang perlu kamu tahu

| Batasan | Penjelasan |
|---|---|
| Harus dipanggil dengan nama skill | Alexa tidak mengizinkan "otak" bawaannya diganti. Mulai dengan *"Alexa, open chat buddy"* atau *"Alexa, ask chat buddy …"*. |
| Belum bisa bahasa Indonesia | Alexa belum mendukung bahasa Indonesia, jadi bicaralah dalam bahasa Inggris (sesuai bahasa Echo-mu). |
| Mode OpenAI tidak browsing | Lewat OpenAI API langsung, info terbaru (berita, cuaca, harga) bisa usang. Mode Hermes bisa mencari di web. |
| Ingatan percakapan di memori | Percakapan 15 menit itu disimpan di memori layanan, jadi hilang kalau layanan di-restart. Ingatan jangka panjang Hermes tidak terpengaruh. |

## Yang dibutuhkan

- Server Linux dengan **Node.js 20.6 atau lebih baru** (`node --version`).
- **Subdomain** yang mengarah ke server, misalnya `alexa.navvied.com`. Alexa hanya mau memanggil **HTTPS port 443**
  dengan sertifikat valid (Let's Encrypt sudah cukup).
- Akun **Amazon Developer** ([developer.amazon.com](https://developer.amazon.com)) dengan **akun Amazon yang sama** seperti di Echo-mu.
- Salah satu:
  - **Mode Hermes:** Hermes Agent di server yang sama, plus langganan ChatGPT untuk login Codex.
  - **Mode OpenAI:** API key dari [platform.openai.com/api-keys](https://platform.openai.com/api-keys) dengan billing aktif.

---

## Langkah setup

### 1. Pasang layanan di server

```bash
sudo useradd --system --home /opt/alexa-chat-gpt --shell /usr/sbin/nologin alexa
sudo git clone https://github.com/navvied/Alexa-Chat-GPT.git /opt/alexa-chat-gpt
cd /opt/alexa-chat-gpt
sudo cp .env.example .env
sudo chown -R root:alexa /opt/alexa-chat-gpt
sudo chmod 640 .env     # key hanya bisa dibaca root dan user alexa
```

Pastikan port `8787` belum dipakai: `ss -ltnp | grep 8787` (kalau dipakai, ganti `PORT` di `.env`
dan di konfigurasi nginx/Caddy).

### 2. Siapkan otaknya

#### Mode Hermes (disarankan)

Buat **profile Hermes khusus Alexa**. Jangan arahkan layanan ini ke Hermes atau profile yang dipakai aplikasi lain.
Dokumentasi Hermes sendiri melarang dua agent memakai satu profile, karena ingatannya akan saling tercampur. Jalankan
sebagai user yang menjalankan Hermes-mu:

```bash
hermes profile create alexa       # profile baru, sekaligus perintah "alexa"
alexa model                       # pilih "ChatGPT or Codex Subscription", lalu login (device code)
openssl rand -hex 32              # salin hasilnya untuk API_SERVER_KEY di bawah
nano ~/.hermes/profiles/alexa/.env
```

Isi `~/.hermes/profiles/alexa/.env`:

```bash
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1         # hanya bisa diakses dari server ini
API_SERVER_PORT=8650              # port yang belum dipakai
API_SERVER_KEY=hasil-openssl-tadi
```

Lalu **matikan tool berbahaya**. Suara itu pintu terbuka: tamu, anak, atau suara TV bisa menyuruh Alexa. Agent yang
dipanggil lewat suara tidak boleh bisa menjalankan perintah, menyentuh file, atau mengendalikan sistem lain.
Tambahkan ke `~/.hermes/profiles/alexa/config.yaml`:

```yaml
agent:
  disabled_toolsets:
    - terminal
    - file
    - code_execution
    - browser
    - computer_use
    - delegation
    - cronjob
    - skills
    - vision
    - image_gen
    - video_gen
    - homeassistant
    - connections
```

Yang boleh tersisa hanya `web_search`, `web_extract`, `memory`, `session_search`, dan `todo_list`. Supaya web search
bekerja, backend pencariannya juga harus sudah diatur (`alexa tools`). Jalankan gateway profile ini
(`alexa gateway start`, atau sebagai service seperti Hermes-mu yang lain), lalu cek:

```bash
curl -H "Authorization: Bearer hasil-openssl-tadi" http://127.0.0.1:8650/v1/toolsets
```

Kamu tidak perlu menebak daftar ini sampai benar. Saat start (dan setiap 5 menit), layanan ini mengecek
`/v1/toolsets`. Kalau masih ada tool di luar daftar aman, layanan **menolak jalan** dan log-nya menyebut tool mana
saja yang masih terbuka, jadi tinggal tambahkan toolset-nya ke `disabled_toolsets`.

Isi `/opt/alexa-chat-gpt/.env`:

```bash
CHAT_PROVIDER=hermes
HERMES_BASE_URL=http://127.0.0.1:8650/v1
HERMES_API_KEY=hasil-openssl-tadi
```

Kalau Hermes ada di server lain, `HERMES_BASE_URL` wajib `https://`. Layanan menolak mengirim key lewat HTTP biasa
ke luar server.

#### Mode OpenAI

Isi `/opt/alexa-chat-gpt/.env`:

```bash
CHAT_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

### 3. HTTPS lewat reverse proxy

Buat record DNS **A** untuk `alexa.navvied.com` yang mengarah ke IP server.

**Kalau server sudah memakai nginx:**

```bash
sudo cp deploy/nginx-alexa.conf /etc/nginx/sites-available/alexa.conf
sudo sed -i 's/alexa.example.com/alexa.navvied.com/g' /etc/nginx/sites-available/alexa.conf
sudo ln -s /etc/nginx/sites-available/alexa.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx      # nginx -t dulu: jangan reload kalau ada error
sudo certbot --nginx -d alexa.navvied.com         # menambah HTTPS 443 + sertifikat Let's Encrypt
```

File ini berdiri sendiri (server block baru untuk subdomain baru) dan tidak mengubah situs lain di server.

**Kalau memakai Caddy:** salin isi `deploy/Caddyfile` ke Caddyfile-mu, ganti domainnya, lalu `sudo systemctl reload caddy`.

### 4. Buat skill di Alexa Developer Console

1. Buka [developer.amazon.com/alexa/console/ask](https://developer.amazon.com/alexa/console/ask), lalu **Create Skill**.
2. Nama: `Chat Buddy`. **Primary locale** harus **sama dengan bahasa Echo-mu** (cek di aplikasi Alexa, Device, Language).
   Biasanya **English (US)**.
3. Pilih model **Custom**, hosting **Provision your own**, template **Start from scratch**.
4. **Build, Interaction Model, JSON Editor.** Hapus semua isinya, tempel isi file
   [`interaction-model/en-US.json`](interaction-model/en-US.json), lalu **Save** dan **Build skill**.
5. **Build, Endpoint:** pilih **HTTPS**, lalu isi *Default Region* dengan `https://alexa.navvied.com/alexa`.
   Untuk jenis sertifikat SSL, pilih **"My development endpoint has a certificate from a trusted certificate authority"**. Lalu **Save**.
6. Salin **Skill ID** (`amzn1.ask.skill.…`) yang tampil di halaman Endpoint.

### 5. Isi Skill ID dan jalankan

```bash
sudo nano /opt/alexa-chat-gpt/.env      # ALEXA_SKILL_ID=amzn1.ask.skill.…
sudo cp /opt/alexa-chat-gpt/deploy/alexa-chat-gpt.service /etc/systemd/system/
which node                              # kalau bukan /usr/bin/node, sesuaikan ExecStart di file service
sudo systemctl daemon-reload
sudo systemctl enable --now alexa-chat-gpt
sudo journalctl -u alexa-chat-gpt -f    # harus muncul: INFO listening …
curl https://alexa.navvied.com/healthz  # {"ok":true}
```

Kalau layanan berhenti dengan exit code `78`, berarti ada yang salah di pengaturan (atau tool Hermes masih terbuka).
Baca pesan di log, perbaiki, lalu `sudo systemctl restart alexa-chat-gpt`. Untuk kesalahan seperti ini, systemd
sengaja tidak mengulang-ulang start.

### 6. Tes

1. Di Developer Console, buka tab **Test** dan ubah *Skill testing is enabled in* menjadi **Development**.
2. Ketik `open chat buddy`, lalu `what is the tallest mountain in the world`.
3. Di Echo: **"Alexa, open chat buddy"**. Skill dalam mode development otomatis aktif di semua Echo
   yang memakai akun Amazon yang sama dengan akun developer. Skill ini **tidak perlu di-publish**.

---

## Cara pakai

| Kamu bilang | Yang terjadi |
|---|---|
| "Alexa, open chat buddy" | Mulai (atau lanjutkan) percakapan. Setelah itu langsung bicara saja, tanpa "Alexa". |
| "Alexa, ask chat buddy why the sky is blue" | Bertanya langsung dalam satu kalimat. |
| *(setelah dijawab)* "and how about on Mars?" | Pertanyaan lanjutan. Konteks sebelumnya diingat. |
| "continue" | Mendengar jawaban yang tadi butuh waktu lebih lama. |
| "start over" / "new topic" | Mulai percakapan baru. |
| "remember that my daughter's name is Sari" | *(Hermes)* Disimpan di ingatan jangka panjang. |
| "help" | Petunjuk singkat. |
| "stop" / "cancel" | Alexa berhenti mendengar. Percakapan tetap diingat 15 menit. |

**Mau ganti nama panggilan?** Ubah `invocationName` di JSON Editor. Nama harus minimal dua kata, huruf kecil, dan
tanpa kata "alexa", "echo", "skill", atau "app". Huruf tunggal ditulis dengan titik dan spasi, misalnya `chat g. p. t.`
(nama merek bisa ditolak kalau suatu saat skill di-publish). Setelah itu Build ulang.

## Tentang ingatan

- **Percakapan (kedua mode).** Layanan ini mengingat percakapan per orang selama `CONVERSATION_IDLE_MINUTES`
  (default 15) sejak pertanyaan terakhir. Di mode Hermes, riwayatnya disimpan oleh Hermes sendiri
  (satu *conversation* Hermes per percakapan), lengkap dengan hasil pencarian web.
- **Jangka panjang (Hermes).** Hermes menyimpan catatan penting di `MEMORY.md` dan `USER.md` milik profile `alexa`,
  dan bisa mencari obrolan lama. Ruangnya terbatas (sekitar 2.200 + 1.375 karakter catatan), dan catatan hanya
  tersimpan kalau model benar-benar memakai tool `memory`. Cek dengan `cat ~/.hermes/profiles/alexa/memories/*.md`.
- **Satu rumah, satu ingatan jangka panjang.** `MEMORY.md` milik profile, jadi dipakai bersama oleh semua orang
  yang bicara ke skill ini. Layanan ini mengirim kunci per orang (`X-Hermes-Session-Key`, hasil hash dari voice
  profile atau akun Amazon), yang dipakai oleh *memory provider* eksternal Hermes seperti Honcho untuk memisahkan
  ingatan per orang.

## Konfigurasi

Semua pengaturan ada di `.env`. Lihat [`.env.example`](.env.example) untuk daftar lengkap. Yang paling sering diubah:

| Variabel | Default | Keterangan |
|---|---|---|
| `CHAT_PROVIDER` | `openai` | `hermes` atau `openai`. |
| `HERMES_BASE_URL` | | URL API server profile Hermes, diakhiri `/v1`. |
| `HERMES_EXTRA_TOOLS` | | Tool Hermes tambahan yang **sengaja** diizinkan, dipisah koma (misalnya `ha_get_state`). |
| `OPENAI_MODEL` | `chat-latest` | Model yang dipakai ChatGPT saat ini (mode OpenAI). |
| `SYSTEM_PROMPT` | *(bawaan)* | Gaya jawaban. Defaultnya: singkat, tanpa markdown, cocok untuk suara. |
| `CONVERSATION_IDLE_MINUTES` | `15` | Berapa lama percakapan diingat sejak pertanyaan terakhir. |
| `MAX_HISTORY_TURNS` | `10` | Jumlah tanya-jawab yang dikirim ulang ke OpenAI (mode OpenAI). |
| `ANSWER_DEADLINE_MS` | `6000` | Batas tunggu sebelum Alexa bilang "say continue" (maksimum 7500, karena Alexa memberi 8 detik). |
| `TIMEZONE` | `Asia/Jakarta` | Supaya otaknya tahu tanggal dan jam sekarang. |
| `LOG_CONVERSATIONS` | `false` | `true` untuk mencatat isi tanya-jawab di log. |

Setelah mengubah `.env`, jalankan `sudo systemctl restart alexa-chat-gpt`.

## Biaya

- **Mode Hermes:** memakai kuota langganan ChatGPT yang login di profile `alexa`. Aturan kuota Codex lewat Hermes
  belum didokumentasikan oleh Hermes. Kalau kuotanya habis, Alexa akan minta maaf dan log menyebut alasannya.
- **Mode OpenAI:** dibayar per token. Satu pertanyaan kira-kira memakan 1.000 token masuk dan 150 token keluar.
  Cek harga di [openai.com/api/pricing](https://openai.com/api/pricing), dan pasang **batas pemakaian bulanan**
  di dashboard OpenAI.

## Kalau ada masalah

Lihat log dulu: `sudo journalctl -u alexa-chat-gpt -n 100`

| Gejala | Penyebab dan solusi |
|---|---|
| Alexa: *"There was a problem with the requested skill's response"* | Lihat log. `request rejected … 403` berarti `ALEXA_SKILL_ID` salah. `signature check failed` berarti request bukan dari Alexa, atau proxy mengubah body. |
| Tidak ada log sama sekali saat dites | Request tidak sampai ke server. Cek DNS, sertifikat HTTPS, URL endpoint di console (harus berakhiran `/alexa`), dan firewall port 443. |
| `Hermes exposes tools that must not be reachable by voice: …` | Tambahkan toolset yang disebut ke `agent.disabled_toolsets` di profile `alexa`, restart gateway-nya, lalu restart layanan ini. |
| `Hermes tool check failed with HTTP 401` / `404` | `HERMES_API_KEY` tidak sama dengan `API_SERVER_KEY`, atau `HERMES_BASE_URL` salah (harus diakhiri `/v1`). |
| `hermes is not reachable yet` | Gateway profile `alexa` belum jalan, atau port-nya beda. |
| `Hermes reported a problem: …` | Masalah di sisi Hermes, misalnya login ChatGPT kedaluwarsa (`alexa model` untuk login ulang) atau kuota habis. |
| `chat failed … HTTP 401` (mode OpenAI) | `OPENAI_API_KEY` salah atau dicabut. |
| `chat failed … HTTP 429` (mode OpenAI) | Saldo/kuota OpenAI habis atau terkena rate limit. |
| Sering "say continue" | Otaknya lambat. Di Hermes ini wajar saat mencari di web. Bisa juga minta jawaban lebih singkat lewat `SYSTEM_PROMPT`. |
| Ucapan sering salah tangkap | Bicara dalam bahasa Inggris dengan jelas. Alexa mengenali kalimat bebas tidak sesempurna ChatGPT voice. |
| Layanan gagal start: `Invalid configuration` | Pesan error menyebut variabel mana yang salah. |

## Keamanan

- `.env` berisi key: jangan pernah di-commit (sudah ada di `.gitignore`), dan izinnya `640`.
- Layanan hanya listen di `127.0.0.1`, jadi dari internet hanya bisa diakses lewat reverse proxy, dan hanya di path `/alexa`.
- Verifikasi request mengikuti
  [aturan Amazon](https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html):
  URL sertifikat, rantai sertifikat sampai root CA tepercaya, nama `echo-api.amazon.com`, tanda tangan RSA-SHA256
  atas body, dan stempel waktu ±150 detik. Semuanya memakai `crypto` bawaan Node (OpenSSL). Library resmi
  `ask-sdk-express-adapter` sengaja tidak dipakai karena bergantung pada `node-forge`, yang punya celah keamanan
  belum diperbaiki (GHSA-86w9-cpqp-85rv) tepat di bagian verifikasi sertifikat.
- **Mode Hermes:** API server Hermes membawa seluruh tool agent, termasuk terminal. Layanan ini hanya mau bekerja
  kalau tool yang terbuka seluruhnya ada di daftar aman (`web_search`, `web_extract`, `memory`, `session_search`,
  `todo_list`) atau sengaja kamu tambahkan di `HERMES_EXTRA_TOOLS`. Ini dicek saat start dan setiap 5 menit. Key Hermes
  tidak pernah dikirim lewat HTTP biasa ke luar server, dan ID akun Amazon dikirim ke Hermes hanya dalam bentuk hash.
- **Jangan pernah** menyalakan `ALEXA_SKIP_VERIFICATION=true` di server publik.

## Update

```bash
cd /opt/alexa-chat-gpt && sudo git pull && sudo systemctl restart alexa-chat-gpt
```

## Pengembangan

```bash
npm test            # tanpa internet, tanpa API key, tanpa Hermes sungguhan
```

| File | Isi |
|---|---|
| `src/main.js` | Titik masuk: menyambungkan semua bagian, cek tool Hermes, menjalankan server |
| `src/server.js` | Endpoint HTTP: verifikasi, cek Skill ID, batas ukuran body |
| `src/verify.js` | Verifikasi tanda tangan dan stempel waktu request Alexa |
| `src/alexa.js` | Menerjemahkan intent Alexa ke percakapan, identitas pembicara, progressive response |
| `src/assistant.js` | Logika percakapan: batas 8 detik, jawaban tertunda ("continue"), riwayat |
| `src/conversations.js` | Percakapan per orang, berakhir setelah 15 menit tanpa pertanyaan |
| `src/hermes.js` | Klien Hermes (Responses API + conversation) dan pengecekan tool |
| `src/llm.js` | Klien OpenAI Chat Completions |
| `src/speech.js` | Membersihkan markdown, link, dan emoji agar enak dibacakan, escaping SSML, kartu |
| `interaction-model/en-US.json` | Model interaksi untuk Alexa Developer Console |
| `test/fixtures/` | Sertifikat **khusus tes** (dibuat oleh `generate.sh`), tidak melindungi apa pun |
