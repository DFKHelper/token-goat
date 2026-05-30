package com.example;

import java.util.List;
import java.util.HashMap;

public class UserService {
    public static final String VERSION = "1.0";
    private static final int MAX_SIZE = 100;

    private final String name;

    public UserService(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }

    private static int count(List<?> items) {
        return items.size();
    }

    public static UserService create(String n) {
        return new UserService(n);
    }
}

public interface Processor {
    void process(String input);

    default String preprocess(String s) {
        return s.trim();
    }
}

public enum Status {
    ACTIVE, INACTIVE, PENDING;

    public boolean isActive() {
        return this == ACTIVE;
    }
}

@interface MyAnnotation {
    String value();
    int timeout() default 30;
}

abstract class AbstractBase {
    abstract void doWork();
}
