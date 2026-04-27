import io.github.treesitter.jtreesitter.Language;
import io.github.treesitter.jtreesitter.androidlog.TreeSitterAndroidlog;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

public class TreeSitterAndroidlogTest {
    @Test
    public void testCanLoadLanguage() {
        assertDoesNotThrow(() -> new Language(TreeSitterAndroidlog.language()));
    }
}
