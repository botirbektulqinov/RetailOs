# RetailOS — AWS EC2 ga deploy

Bitta t3.small serverda: PostgreSQL, API va Caddy (avtomatik HTTPS). Hammasi
Docker ichida, bitta `docker compose` buyrug'i bilan.

Quyidagi qadamlar **tartib bilan** bajariladi. Har birining oxirida tekshiruv
buyrug'i bor — u ishlamasa, keyingisiga o'tmang.

| Nima | Qayerda |
|---|---|
| Server | `13.63.129.185` · eu-north-1 · Ubuntu · t3.small (2 vCPU, 2 GB) |
| API | `https://SIZNING-DOMEN/api/v1` |
| Swagger | `https://SIZNING-DOMEN/api/docs` |
| Ma'lumotlar bazasi | Docker ichida, tashqaridan **umuman ochiq emas** |

---

## 1. AWS Security Group — 80 va 443 portlarini oching

Bu birinchi va eng ko'p unutiladigan qadam. Ochilmasa Caddy sertifikat ololmaydi
va sayt ochilmaydi.

**EC2 console → Instances → `i-0f1b9fc5fcd70d9f7` → Security tab → Security
groups → havolani bosing → Inbound rules → Edit inbound rules → Add rule:**

| Type | Port | Source |
|---|---|---|
| HTTP | 80 | `0.0.0.0/0` |
| HTTPS | 443 | `0.0.0.0/0` |
| SSH | 22 | **faqat sizning IP** (`My IP`) |

> SSH ni `0.0.0.0/0` da qoldirmang. Butun internet sizning 22-portingizga
> parol tanlashga urinib turadi.

PostgreSQL uchun **hech qanday qoida qo'shmang**. Baza faqat Docker tarmog'i
ichida ishlaydi — internetga chiqarilmagan.

---

## 2. Serverga ulaning

```bash
# .pem kalitingiz yonida:
chmod 400 retailos-key.pem
ssh -i retailos-key.pem ubuntu@13.63.129.185
```

Ulanmasa: Security Group da 22-port sizning IP ga ochiqmi, kalit fayl to'g'rimi,
foydalanuvchi `ubuntu` mi (Ubuntu AMI uchun shunday) — shularni tekshiring.

---

## 3. Swap qo'shing — 2 GB

t3.small da atigi 2 GB RAM bor. Docker image ni qurish (`npm ci` + `nest build`)
shunga yaqin joy egallaydi va **swap bo'lmasa build o'rtasida o'ladi**. Bu bir
marta bajariladi.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Tekshiruv:**
```bash
free -h        # Swap qatorida 2.0Gi ko'rinishi kerak
```

---

## 4. Docker o'rnating

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Har safar `sudo` yozmaslik uchun:
sudo usermod -aG docker $USER
newgrp docker
```

**Tekshiruv:**
```bash
docker compose version    # v2.x ko'rinishi kerak
```

> `VERSION_CODENAME` topilmasa (juda yangi Ubuntu relizi), uning o'rniga
> `UBUNTU_CODENAME` ni ishlating yoki bir oldingi LTS kodini (`noble`) qo'ying.

---

## 5. Domenni serverga yo'naltiring

Domen olgan joyingizning DNS panelida (Cloudflare, Namecheap, ahost.uz — farqi
yo'q) ikkita **A record** qo'shing:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | `13.63.129.185` | Auto |
| A | `api` | `13.63.129.185` | Auto |

**Cloudflare ishlatsangiz:** bulut belgisini **kulrang** (DNS only) qiling.
To'q sariq (proxied) holatda Caddy sertifikat ololmaydi.

**Tekshiruv** (o'z kompyuteringizdan, serverdan emas):
```bash
nslookup api.sizningdomen.uz
# Javobda 13.63.129.185 chiqishi kerak
```

DNS tarqalishi 5 daqiqadan bir necha soatgacha ketishi mumkin. **Bu chiqmaguncha
6-qadamga o'tmang** — Let's Encrypt haftasiga 5 martagina urinishga ruxsat
beradi, behuda sarflab qo'ymang.

---

## 6. Kodni oling va `.env` yozing

```bash
git clone https://github.com/botirbektulqinov/RetailOs.git
cd RetailOs
```

Endi maxfiy kalitlarni generatsiya qilib, `.env` faylini yozamiz. **Pastdagi
blokni butunligicha** nusxalab qo'ying — kalitlar o'zi generatsiya bo'ladi,
siz faqat `DOMAIN` qatorini o'zgartirasiz:

```bash
cat > .env <<EOF
# ── Domen — SHU IKKI QATORNI O'ZGARTIRING ──
DOMAIN=api.sizningdomen.uz
CORS_ORIGINS=https://sizningdomen.uz,https://api.sizningdomen.uz

# ── Baza ──
POSTGRES_USER=retailos
POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
POSTGRES_DB=retailos

# ── Maxfiy kalitlar (avtomatik) ──
JWT_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)

# ── Boshqalar ──
SWAGGER_ENABLED=true
LOG_LEVEL=info
EOF

chmod 600 .env
```

`DOMAIN` va `CORS_ORIGINS` ni haqiqiy domeningizga almashtiring:

```bash
nano .env      # Ctrl+O saqlash, Ctrl+X chiqish
```

**Tekshiruv:**
```bash
grep -c 'sizningdomen' .env    # 0 chiqishi kerak — ya'ni hammasini almashtirdingiz
```

> `.env` faylini **hech qachon** git ga qo'shmang. `.gitignore` da allaqachon
> yozilgan, lekin bilib turganingiz yaxshi. Ichida bazaning paroli va JWT
> kalitlari bor — ular chiqib ketsa har qanday foydalanuvchi nomidan token
> yasash mumkin bo'ladi.

---

## 7. Ishga tushiring

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Birinchi marta 3–6 daqiqa oladi (image quriladi, migratsiyalar yuriladi, Caddy
sertifikat oladi). Kuzatib turish uchun:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

**Tekshiruv:**
```bash
docker compose -f docker-compose.prod.yml ps
# postgres  Up (healthy)
# migrate   Exited (0)     ← bu normal, u bir marta ishlab tugaydi
# api       Up (healthy)
# caddy     Up

curl https://api.sizningdomen.uz/api/v1/health
# {"status":"ok", ...}
```

---

## 8. Demo ma'lumot (ixtiyoriy)

Bo'sh bazaga birinchi tashkilot va foydalanuvchilarni yozadi:

```bash
docker compose -f docker-compose.prod.yml run --rm migrate npx tsx prisma/seed.ts
```

Kirish: `+998901234567` / `RetailOS2026`.

> **Bu demo parol.** Ishlab chiqarishda ishlatmoqchi bo'lsangiz, birinchi
> kirishdanoq parolni almashtiring, yoki seed ni umuman yurgizmay, o'z
> tashkilotingizni qo'lda yarating.

---

## Tayyor — endi nima bor

| Manzil | Nima |
|---|---|
| `https://api.sizningdomen.uz/api/docs` | **Swagger** — 100+ endpoint, "Try it out" ishlaydi |
| `https://api.sizningdomen.uz/api/docs/json` | OpenAPI JSON (frontend uchun client generatsiya qilinadi) |
| `https://api.sizningdomen.uz/api/v1/health` | Health check |
| `https://api.sizningdomen.uz/api/v1/auth/login` | Kirish |

Swagger da ishlash: `/auth/login` dan `accessToken` oling → yuqoridagi
**Authorize** tugmasini bosing → tokenni qo'ying → endi barcha endpointlar
ochiladi.

---

## Yangilash

Kodni o'zgartirgandan keyin:

```bash
cd ~/RetailOs
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Migratsiyalar avtomatik yuriladi (`migrate` servisi `api` dan oldin tugaydi).

---

## Nosozlik bo'lsa

| Belgi | Sababi |
|---|---|
| Sayt ochilmaydi, `curl` "connection refused" | Security Group da 80/443 yopiq (1-qadam) |
| Brauzer sertifikat xatosi beradi | DNS hali tarqalmagan, yoki Cloudflare proxy yoqilgan (5-qadam) |
| `api` konteyner qayta-qayta o'chadi | `docker compose -f docker-compose.prod.yml logs api` — deyarli har doim `.env` dagi xato |
| Build o'rtasida "killed" / OOM | Swap qo'shilmagan (3-qadam) |
| `CORS_ORIGINS: must list at least one origin` | `.env` da `CORS_ORIGINS` bo'sh |
| Frontend dan so'rov CORS xatosi beradi | Frontend manzili `CORS_ORIGINS` ro'yxatida yo'q |

Loglar:
```bash
docker compose -f docker-compose.prod.yml logs api --tail 100
docker compose -f docker-compose.prod.yml logs caddy --tail 50
```

---

## Keyingi qadamlar (hozir shart emas)

- **Elastic IP.** Hozirgi `13.63.129.185` server to'xtab-yonsa o'zgaradi va
  domen ishlamay qoladi. EC2 → Elastic IPs → Allocate → Associate.
- **Zaxira nusxa.** Baza Docker volume da. Kundalik dump:
  `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U retailos retailos | gzip > backup-$(date +%F).sql.gz`
- **RDS.** Baza o'sganda uni alohida Amazon RDS ga ko'chirish — `DATABASE_URL`
  ni almashtirish kifoya, kod o'zgarmaydi.
- **Swagger ni yopish.** `SWAGGER_ENABLED=false` — API ichki ishlatilsa,
  butun interfeysni ommaga ko'rsatish shart emas.
