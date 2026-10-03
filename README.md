# Alexa Chat GPT

Skill Alexa buatan sendiri yang menjawab pakai **ChatGPT**, dan jalan di **server milikmu sendiri**.
Tanpa Lambda, tanpa skill pihak ketiga, dan tanpa dependency npm (cukup Node.js).

```
"Alexa, open chat buddy"
        │
        ▼
  Echo ──► Amazon Alexa ──HTTPS──► servermu (nginx/Caddy :443) ──► layanan ini (:8787) ──► OpenAI API
                                                                         │
                         jawaban dibacakan + kartu teks di aplikasi Alexa ◄┘
```

## Yang bisa dilakukan

- **Ngobrol bebas** dengan ChatGPT lewat Echo. Konteks percakapan diingat sampai kamu bilang *stop*.
- **Model yang sama dengan ChatGPT.** Defaultnya `chat-latest`, alias resmi OpenAI untuk model yang dipakai ChatGPT saat ini.
- **Jawaban panjang tidak hilang.** Alexa hanya menunggu 8 detik. Kalau ChatGPT lebih lama dari itu, Alexa bilang
  *"Say continue"*, lalu jawabannya dibacakan saat kamu bilang **"continue"**.
- **"Let me think."** diucapkan otomatis kalau jawaban butuh lebih dari 1,5 detik, supaya tidak hening.
- **Kartu di aplikasi Alexa** berisi teks lengkap, termasuk link dan kode yang tidak dibacakan.
- **Aman.** Setiap request dicek tanda tangan digitalnya (harus benar-benar dari Amazon), stempel waktunya
  (anti replay), dan Skill ID-nya (hanya skill milikmu). Orang lain tidak bisa memakai kuota API-mu.

## Batasan yang perlu kamu tahu

| Batasan | Penjelasan |
|---|---|
| Harus dipanggil dengan nama skill | Alexa tidak mengizinkan "otak" bawaannya diganti. Mulai dengan *"Alexa, open chat buddy"* atau *"Alexa, ask chat buddy …"*. |
| Belum bisa bahasa Indonesia | Alexa belum mendukung bahasa Indonesia, jadi bicaralah dalam bahasa Inggris (sesuai bahasa Echo-mu). |
| Tidak browsing internet | Lewat API, ChatGPT tidak mencari di web. Berita, cuaca, dan harga terbaru bisa usang, dan ChatGPT diminta mengakui itu. |
| Biaya API terpisah | Langganan ChatGPT Plus/Pro **tidak** berlaku untuk API. API dibayar per pemakaian (lihat [Biaya](#biaya)). |
| Mic tertutup kalau diam | Setelah menjawab, Alexa menunggu sekitar 8 detik. Kalau kamu diam, sesi selesai dan percakapan dilupakan. |

## Yang dibutuhkan

- Server Linux dengan **Node.js 20.6 atau lebih baru** (`node --version`).
- **Domain/subdomain** yang mengarah ke server, misalnya `alexa.domainmu.com`. Alexa hanya mau memanggil **HTTPS port 443**
  dengan sertifikat valid (Let's Encrypt sudah cukup).
- Akun **Amazon Developer** ([developer.amazon.com](https://developer.amazon.com)) dengan **akun Amazon yang sama** seperti di Echo-mu.
- **API key OpenAI** dari [platform.openai.com/api-keys](https://platform.openai.com/api-keys) dengan saldo/billing aktif.

---

## Langkah setup

### 1. Pasang layanan di server

```bash
sudo useradd --system --home /opt/alexa-chat-gpt --shell /usr/sbin/nologin alexa
sudo git clone https://github.com/navvied/Alexa-Chat-GPT.git /opt/alexa-chat-gpt
cd /opt/alexa-chat-gpt
sudo cp .env.example .env
sudo nano .env          # isi OPENAI_API_KEY. ALEXA_SKILL_ID diisi di langkah 4.
sudo chown -R root:alexa /opt/alexa-chat-gpt
sudo chmod 640 .env     # API key hanya bisa dibaca root dan user alexa
```

Pastikan port `8787` belum dipakai: `ss -ltnp | grep 8787` (kalau dipakai, ganti `PORT` di `.env`
dan di konfigurasi nginx/Caddy).

### 2. HTTPS lewat reverse proxy

Buat record DNS **A** untuk `alexa.domainmu.com` yang mengarah ke IP server.

**Kalau server sudah memakai nginx:**

```bash
sudo cp deploy/nginx-alexa.conf /etc/nginx/sites-available/alexa.conf
sudo sed -i 's/alexa.example.com/alexa.domainmu.com/g' /etc/nginx/sites-available/alexa.conf
sudo ln -s /etc/nginx/sites-available/alexa.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx      # nginx -t dulu: jangan reload kalau ada error
sudo certbot --nginx -d alexa.domainmu.com        # menambah HTTPS 443 + sertifikat Let's Encrypt
```

File ini berdiri sendiri (server block baru untuk subdomain baru) dan tidak mengubah situs lain di server.

**Kalau memakai Caddy:** salin isi `deploy/Caddyfile` ke Caddyfile-mu, ganti domainnya, lalu `sudo systemctl reload caddy`.

### 3. Buat skill di Alexa Developer Console

1. Buka [developer.amazon.com/alexa/console/ask](https://developer.amazon.com/alexa/console/ask), lalu **Create Skill**.
2. Nama: `Chat Buddy`. **Primary locale** harus **sama dengan bahasa Echo-mu** (cek di aplikasi Alexa, Device, Language).
   Biasanya **English (US)**.
3. Pilih model **Custom**, hosting **Provision your own**, template **Start from scratch**.
4. **Build, Interaction Model, JSON Editor.** Hapus semua isinya, tempel isi file
   [`interaction-model/en-US.json`](interaction-model/en-US.json), lalu **Save** dan **Build skill**.
5. **Build, Endpoint:** pilih **HTTPS**, lalu isi *Default Region* dengan `https://alexa.domainmu.com/alexa`.
   Untuk jenis sertifikat SSL, pilih **"My development endpoint has a certificate from a trusted certificate authority"**. Lalu **Save**.
6. Salin **Skill ID** (`amzn1.ask.skill.…`) yang tampil di halaman Endpoint.

### 4. Isi Skill ID dan jalankan

```bash
sudo nano /opt/alexa-chat-gpt/.env      # ALEXA_SKILL_ID=amzn1.ask.skill.…
sudo cp /opt/alexa-chat-gpt/deploy/alexa-chat-gpt.service /etc/systemd/system/
which node                              # kalau bukan /usr/bin/node, sesuaikan ExecStart di file service
sudo systemctl daemon-reload
sudo systemctl enable --now alexa-chat-gpt
sudo journalctl -u alexa-chat-gpt -f    # harus muncul: INFO listening …
curl https://alexa.domainmu.com/healthz # {"ok":true}
```

### 5. Tes

1. Di Developer Console, buka tab **Test** dan ubah *Skill testing is enabled in* menjadi **Development**.
2. Ketik `open chat buddy`, lalu `what is the tallest mountain in the world`.
3. Di Echo: **"Alexa, open chat buddy"**. Skill dalam mode development otomatis aktif di semua Echo
   yang memakai akun Amazon yang sama dengan akun developer. Skill ini **tidak perlu di-publish**.

---

## Cara pakai

| Kamu bilang | Yang terjadi |
|---|---|
| "Alexa, open chat buddy" | Mulai percakapan. Setelah itu langsung bicara saja, tanpa "Alexa". |
| "Alexa, ask chat buddy why the sky is blue" | Bertanya langsung dalam satu kalimat. |
| *(setelah dijawab)* "and how about on Mars?" | Pertanyaan lanjutan. Konteks sebelumnya diingat. |
| "continue" | Mendengar jawaban yang tadi butuh waktu lebih lama. |
| "help" | Petunjuk singkat. |
| "stop" / "cancel" / "no" | Selesai. Percakapan dilupakan. |

**Mau ganti nama panggilan?** Ubah `invocationName` di JSON Editor. Nama harus minimal dua kata, huruf kecil, dan
tanpa kata "alexa", "echo", "skill", atau "app". Huruf tunggal ditulis dengan titik dan spasi, misalnya `chat g. p. t.`
(nama merek bisa ditolak kalau suatu saat skill di-publish). Setelah itu Build ulang.

## Konfigurasi

Semua pengaturan ada di `.env`. Lihat [`.env.example`](.env.example) untuk daftar lengkap. Yang paling sering diubah:

| Variabel | Default | Keterangan |
|---|---|---|
| `OPENAI_MODEL` | `chat-latest` | Model yang dipakai ChatGPT saat ini. Ganti ke model yang lebih murah/cepat kalau mau. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Bisa diarahkan ke server lain yang kompatibel dengan OpenAI API. |
| `SYSTEM_PROMPT` | *(bawaan)* | Kepribadian dan gaya jawaban. Defaultnya: singkat, tanpa markdown, cocok untuk suara. |
| `MAX_HISTORY_TURNS` | `10` | Jumlah tanya-jawab yang diingat per percakapan. Makin banyak, makin mahal. |
| `ANSWER_DEADLINE_MS` | `6000` | Batas tunggu sebelum Alexa bilang "say continue" (maksimum 7500, karena Alexa memberi 8 detik). |
| `TIMEZONE` | `Asia/Jakarta` | Supaya ChatGPT tahu tanggal dan jam sekarang. |
| `LOG_CONVERSATIONS` | `false` | `true` untuk mencatat isi tanya-jawab di log. |

Setelah mengubah `.env`, jalankan `sudo systemctl restart alexa-chat-gpt`.

## Biaya

Layanan ini gratis. Yang berbayar adalah **OpenAI API**, dihitung per token. Dengan jawaban pendek dan riwayat
default, kira-kira satu pertanyaan memakan sekitar 1.000 token masuk dan 150 token keluar. Cek harga terbaru
di [openai.com/api/pricing](https://openai.com/api/pricing). Saran:

- Pasang **batas pemakaian bulanan** di dashboard OpenAI (*Settings, Limits*).
- Untuk menghemat: turunkan `MAX_HISTORY_TURNS`, atau pakai model yang lebih murah di `OPENAI_MODEL`.

## Kalau ada masalah

Lihat log dulu: `sudo journalctl -u alexa-chat-gpt -n 100`

| Gejala | Penyebab dan solusi |
|---|---|
| Alexa: *"There was a problem with the requested skill's response"* | Lihat log. `request rejected … 403` berarti `ALEXA_SKILL_ID` salah. `signature check failed` berarti request bukan dari Alexa, atau proxy mengubah body. |
| Tidak ada log sama sekali saat dites | Request tidak sampai ke server. Cek DNS, sertifikat HTTPS, URL endpoint di console (harus berakhiran `/alexa`), dan firewall port 443. |
| `chat failed … HTTP 401` | `OPENAI_API_KEY` salah atau dicabut. |
| `chat failed … HTTP 429` | Saldo/kuota OpenAI habis atau terkena rate limit. |
| `chat failed … HTTP 404` | Nama `OPENAI_MODEL` tidak tersedia untuk akunmu. |
| Sering "say continue" | Model lambat. Pilih model yang lebih cepat, atau minta jawaban lebih singkat lewat `SYSTEM_PROMPT`. |
| Ucapan sering salah tangkap | Bicara dalam bahasa Inggris dengan jelas. Alexa mengenali kalimat bebas tidak sesempurna ChatGPT voice. |
| Layanan gagal start: `Invalid configuration` | Pesan error menyebut variabel mana yang salah. |

## Keamanan

- `.env` berisi API key: jangan pernah di-commit (sudah ada di `.gitignore`), dan izinnya `640`.
- Layanan hanya listen di `127.0.0.1`, jadi dari internet hanya bisa diakses lewat reverse proxy.
- Verifikasi request mengikuti
  [aturan Amazon](https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html):
  URL sertifikat, rantai sertifikat sampai root CA tepercaya, nama `echo-api.amazon.com`, tanda tangan RSA-SHA256
  atas body, dan stempel waktu ±150 detik. Semuanya memakai `crypto` bawaan Node (OpenSSL). Library resmi
  `ask-sdk-express-adapter` sengaja tidak dipakai karena bergantung pada `node-forge`, yang punya celah keamanan
  belum diperbaiki (GHSA-86w9-cpqp-85rv) tepat di bagian verifikasi sertifikat.
- **Jangan pernah** menyalakan `ALEXA_SKIP_VERIFICATION=true` di server publik.

## Update

```bash
cd /opt/alexa-chat-gpt && sudo git pull && sudo systemctl restart alexa-chat-gpt
```

## Pengembangan

```bash
npm test            # 64 tes, tanpa internet dan tanpa API key
```

| File | Isi |
|---|---|
| `src/main.js` | Titik masuk: menyambungkan semua bagian dan menjalankan server |
| `src/server.js` | Endpoint HTTP: verifikasi, cek Skill ID, batas ukuran body |
| `src/verify.js` | Verifikasi tanda tangan dan stempel waktu request Alexa |
| `src/alexa.js` | Menerjemahkan intent Alexa ke percakapan, membangun respons dan progressive response |
| `src/assistant.js` | Logika percakapan: riwayat, batas 8 detik, jawaban tertunda ("continue") |
| `src/llm.js` | Klien OpenAI Chat Completions |
| `src/speech.js` | Membersihkan markdown, link, dan emoji agar enak dibacakan, escaping SSML, kartu |
| `interaction-model/en-US.json` | Model interaksi untuk Alexa Developer Console |
| `test/fixtures/` | Sertifikat **khusus tes** (dibuat oleh `generate.sh`), tidak melindungi apa pun |
