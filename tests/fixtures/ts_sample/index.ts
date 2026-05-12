import { join } from 'node:path';
import express from 'express';

export function greet(name: string): string {
  return `hello, ${name}`;
}

export class UserService {
  constructor(private name: string) {}
  hello(): string {
    return greet(this.name);
  }
}

export interface User {
  id: number;
  name: string;
}

export type UserId = number;

const PORT = 3000;
export const router = express();
