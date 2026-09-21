import bcrypt from "bcrypt";
export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

// Burned on logins where the email doesn't exist so unknown-email and
// wrong-password take the same bcrypt time — otherwise response timing is an
// account-enumeration oracle. (Hash of a random UUID; matches nothing.)
export const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpDSmYkmqCpqRrFKB0F1sO0GJyGyq";
