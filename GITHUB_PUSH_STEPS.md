# Push OppFlo Backend to GitHub

Run these commands **in order** in the Cursor terminal (PowerShell). Your project folder should be the current directory.

---

## Step 1: Go to your project folder (if not already there)

```powershell
cd c:\Users\gregt\OneDrive\Desktop\oppflo-backend2
```

---

## Step 2: Initialize Git

```powershell
git init
```

---

## Step 3: Stage all files (`.env` is ignored by .gitignore)

```powershell
git add .
```

---

## Step 4: Check what will be committed (optional but recommended)

```powershell
git status
```

- You should see your files listed and **no** `.env` in the list. If `.env` appears, do not continue; tell me and we’ll fix .gitignore.

---

## Step 5: Create the first commit

```powershell
git commit -m "Initial commit: OppFlo backend API"
```

---

## Step 6: Name your main branch `main`

```powershell
git branch -M main
```

---

## Step 7: Connect to your GitHub repository

```powershell
git remote add origin https://github.com/creatorversed/oppflo-backend2.git
```

---

## Step 8: Push your code to GitHub

**If the repo on GitHub is empty (no README, no files):**

```powershell
git push -u origin main
```

**If the repo already has files (e.g. a README):** run this first to merge:

```powershell
git pull origin main --allow-unrelated-histories
```

If it asks for a commit message, save and close the editor (or accept the default). Then run:

```powershell
git push -u origin main
```

---

## Step 9: Sign in if prompted

- If a browser or login window opens, sign in to GitHub and approve access.
- If it asks for username: `creatorversed`
- If it asks for password: use a **Personal Access Token** (GitHub no longer accepts account passwords for Git). Create one at: GitHub → Settings → Developer settings → Personal access tokens → Generate new token. Give it `repo` scope and paste it when asked for a password.

---

Done. Your code will be at: **https://github.com/creatorversed/oppflo-backend2**
