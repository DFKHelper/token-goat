package com.example

import java.util.List
import java.util.HashMap

class UserService(val name: String) {
    companion object {
        const val VERSION = "1.0"
    }

    fun getName(): String = name

    private fun count(items: List<*>): Int = items.size

    fun create(n: String): UserService = UserService(n)
}

interface Processor {
    fun process(input: String)
    fun preprocess(s: String): String = s.trim()
}

enum class Status {
    ACTIVE, INACTIVE, PENDING;

    fun isActive(): Boolean = this == ACTIVE
}

object Singleton {
    fun getInstance(): Singleton = this
}

data class User(val id: Int, val name: String)

fun topLevelFn(): Unit = Unit
