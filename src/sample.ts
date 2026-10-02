export const SAMPLE_CPP = `#include <vector>

int firstPositive(const std::vector<int>& values) {
    // Scan until a positive value appears.
    for (int value : values) {
        if (value > 0) {
            return value;
        }
    }

    return 0;
}
`;
